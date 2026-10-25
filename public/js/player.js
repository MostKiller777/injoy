import { getPlay, getSources } from './api.js';
import { createDashFeeder } from './dash.js';
import {
  progressFor,
  rememberShown,
  saveProgress,
  setSourcePreference,
  setVolume,
  state,
} from './state.js';
import { el, formatTime, icon, toast } from './ui.js';

const SPEEDS = [1, 1.25, 1.5, 0.75, 1.75, 2];
const SAVE_INTERVAL = 5_000;

const KEY_ROWS = [
  ['Space / K', 'Play or pause'],
  ['← / →', 'Seek 10 seconds'],
  ['J / L', 'Seek 10 seconds'],
  ['M', 'Mute'],
  ['F', 'Fullscreen'],
  ['? / H', 'Shortcuts panel'],
  ['Esc', 'Close the player'],
];

/**
 * Feed a raw MPEG-TS file into a <video> element through Media Source
 * Extensions.
 *
 * Browsers will not open `video/mp2t` as a plain `src` — `canPlayType` returns
 * an empty string — but MSE accepts the same bytes and demuxes them, so the
 * file streams in chunk by chunk. That is what makes a downloaded `.ts`
 * playable without remuxing it server-side.
 *
 * Two constraints shape the implementation:
 * - The source buffer has a fixed byte quota (roughly 150 MB in Chrome). Push a
 *   whole film at it and the browser silently evicts the head of the timeline,
 *   so playback never starts and seeking back is impossible. Instead the
 *   feeder keeps a bounded window: it reads only while less than `LOOKAHEAD`
 *   seconds sit ahead of the playhead.
 * - A transport stream carries no index, so time cannot be mapped to bytes.
 *   The feeder records checkpoints as it appends — byte offset to media time —
 *   and uses the nearest one to resume a range request when the user seeks
 *   outside the window.
 *
 * Returns a teardown function, or null when MSE cannot take the codec (the
 * caller then falls back to a plain <source> and lets the browser try).
 */
function createTransportStreamFeeder(videoEl, url, { duration = null, bytes = null, startAt = null, onError } = {}) {
  const MIME = 'video/mp2t; codecs="avc1.42E01E,mp4a.40.2"';
  if (typeof MediaSource === 'undefined' || !MediaSource.isTypeSupported(MIME)) return null;

  const totalBytes = Number.isFinite(bytes) && bytes > 0 ? bytes : null;
  const LOOKAHEAD = 45;      // seconds of media buffered ahead of the playhead
  const MAX_PENDING = 6;     // chunks held in memory while the buffer is full
  const CHUNK_TARGET = 512 * 1024;

  const mediaSource = new MediaSource();
  const objectUrl = URL.createObjectURL(mediaSource);
  const checkpoints = [];    // { byte, time } — sorted, time is the range end

  let sourceBuffer = null;
  let controller = null;
  let reader = null;
  let pending = [];          // { data, byte }
  let nextByte = 0;
  let busy = false;
  let stopped = false;
  let inputDone = false;
  let landAt = null;         // media time to jump to once the buffer covers it
  let restartTo = null;      // pending re-fetch target after a backward seek
  let roomWaiter = null;
  let primed = false;        // the element has been placed on the timeline once
  const desiredStart = Number.isFinite(startAt) && startAt > 0 ? startAt : null;

  videoEl.src = objectUrl;

  const releaseRoom = () => {
    const waiter = roomWaiter;
    roomWaiter = null;
    waiter?.();
  };

  // Chunks arrive as Uint8Array; there is no Buffer in the browser.
  const concat = (a, b) => {
    if (!a) return b;
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
  };

  const fail = (err) => {
    if (stopped) return;
    stopped = true;
    controller?.abort();
    onError?.(err);
  };

  const lastBufferedEnd = () => {
    const { buffered } = sourceBuffer ?? videoEl;
    if (!buffered || !buffered.length) return 0;
    return buffered.end(buffered.length - 1);
  };

  const coversTime = (time) => {
    const { buffered } = videoEl;
    for (let i = 0; i < buffered.length; i += 1) {
      if (time >= buffered.start(i) - 0.5 && time <= buffered.end(i)) return true;
    }
    return false;
  };

  /** Nearest checkpoint at or before `time`, or 0 when the index is empty. */
  const byteForTime = (time) => {
    let best = 0;
    for (const point of checkpoints) {
      if (point.time <= time) best = point.byte;
      else break;
    }
    return best;
  };

  const recordCheckpoint = (chunk) => {
    const end = lastBufferedEnd();
    if (!end) return;
    const byte = chunk.byte + chunk.data.length;
    const previous = checkpoints[checkpoints.length - 1];
    if (previous && (byte <= previous.byte || end <= previous.time)) return;
    checkpoints.push({ byte, time: end });
  };

  const drain = () => {
    if (stopped || restartTo !== null || busy || !sourceBuffer || !pending.length) return;
    // Hold the read-ahead window: appending past it is what triggers eviction.
    if (sourceBuffer.buffered.length && lastBufferedEnd() - videoEl.currentTime >= LOOKAHEAD) return;

    const chunk = pending[0];
    busy = true;
    try {
      sourceBuffer.appendBuffer(chunk.data);
      pending.shift();
      recordCheckpoint(chunk);
      releaseRoom();
    } catch (err) {
      busy = false;
      if (err.name === 'QuotaExceededError') {
        // The window should make this unreachable, but a stream with a wildly
        // different bitrate can still get here: drop the played tail and retry.
        const { buffered, currentTime } = videoEl;
        if (!buffered.length) return fail(new Error('media buffer full'));
        const start = buffered.start(0);
        const end = Math.min(buffered.end(0), currentTime - 10);
        if (!(end > start)) return fail(new Error('media buffer full'));
        busy = true;
        try {
          sourceBuffer.remove(start, end);
        } catch (removeErr) {
          busy = false;
          fail(removeErr);
        }
        return;
      }
      pending.shift();
      releaseRoom();
      fail(err);
    }
  };

  const doRestart = () => {
    const target = restartTo;
    restartTo = null;
    if (target === null) return;

    landAt = target;
    controller?.abort();
    reader = null;
    pending = [];
    nextByte = byteForTime(target);

    const end = lastBufferedEnd();
    if (end > 0) {
      try {
        sourceBuffer.remove(0, end);
      } catch {
        // the buffer is already empty or mid-append; the next pull replaces it
      }
    }
    void pull();
  };

  /**
   * Move the playhead. Inside the window that is just a seek; outside it the
   * byte source has to be re-opened. Without an index the offset is estimated
   * from the byte/time ratio, which is close enough for a constant-bitrate
   * stream — the demuxer resyncs on the next PES header anyway.
   */
  const jumpTo = (target) => {
    if (checkpoints.length) {
      restartTo = target;
      if (!busy) doRestart();
      return;
    }

    landAt = target;
    if (totalBytes && Number.isFinite(duration) && duration > 0) {
      const first = videoEl.buffered.length ? videoEl.buffered.start(0) : 0;
      const ratio = Math.min(1, Math.max(0, (target - first) / Math.max(1, duration)));
      controller?.abort();
      reader = null;
      pending = [];
      nextByte = Math.floor(totalBytes * ratio);
      void pull();
      return;
    }

    // No size or duration to work with: refill from the start of the file and
    // land as soon as the timeline reaches the target.
    restartTo = target;
    if (!busy) doRestart();
  };

  const finish = () => {
    if (mediaSource.readyState !== 'open') return;
    try {
      mediaSource.endOfStream();
    } catch {
      // already ended, or the element detached mid-flight
    }
  };

  mediaSource.addEventListener('sourceopen', () => {
    try {
      sourceBuffer = mediaSource.addSourceBuffer(MIME);
    } catch (err) {
      return fail(err);
    }

    // A known duration turns the element into a proper VOD timeline: the
    // scrubber spans the film instead of collapsing to zero.
    if (Number.isFinite(duration) && duration > 0) {
      try {
        mediaSource.duration = duration;
      } catch {
        // some builds refuse a duration before the first append
      }
    }

    sourceBuffer.addEventListener('updateend', () => {
      busy = false;
      if (restartTo !== null) return doRestart();

      // The element starts at zero, but a transport stream usually starts at a
      // non-zero PTS — parked before the first buffered frame, it would never
      // play. Place it on the timeline exactly once.
      if (!primed && videoEl.buffered.length) {
        primed = true;
        const first = videoEl.buffered.start(0);
        // The probe measured a span, not an absolute time; the real end of the
        // film is the first timestamp plus that span.
        if (Number.isFinite(duration) && duration > 0) {
          try {
            mediaSource.duration = first + duration;
          } catch {
            // the element is mid-append; the earlier estimate stays
          }
        }
        if (desiredStart !== null && !coversTime(desiredStart)) jumpTo(desiredStart);
        else videoEl.currentTime = desiredStart ?? first;
      }

      if (landAt !== null && coversTime(landAt)) {
        const target = landAt;
        landAt = null;
        videoEl.currentTime = target;
      }

      if (inputDone && !pending.length && nextByte >= (totalBytes ?? Infinity)) finish();
      else drain();
    });
    sourceBuffer.addEventListener('error', () => fail(new Error('media append failed')));
    void pull();
  }, { once: true });

  const onTimeUpdate = () => drain();
  const onSeeking = () => {
    if (!sourceBuffer || stopped) return;
    const target = videoEl.currentTime;
    if (coversTime(target)) return;
    jumpTo(target);
  };

  videoEl.addEventListener('timeupdate', onTimeUpdate);
  videoEl.addEventListener('seeking', onSeeking);

  async function pull() {
    const localController = new AbortController();
    controller = localController;
    const startAt = nextByte;

    try {
      const res = await fetch(url, {
        headers: startAt > 0 ? { range: `bytes=${startAt}-` } : {},
        signal: localController.signal,
      });
      if (!res.ok || !res.body) throw new Error(`${res.status} ${res.statusText}`);
      reader = res.body.getReader();

      let buffer = null;
      let bufferLength = 0;

      while (!stopped && !localController.signal.aborted) {
        if (pending.length >= MAX_PENDING) {
          await new Promise((resolve) => {
            roomWaiter = resolve;
          });
          continue;
        }

        const { done, value } = await reader.read();
        if (done) break;

        // Chunks from the network have no fixed size; stitch them into roughly
        // half-megabyte pieces so the checkpoint index stays small.
        buffer = concat(buffer, value);
        bufferLength = buffer.length;
        if (bufferLength < CHUNK_TARGET) continue;

        pending.push({ data: buffer, byte: nextByte });
        nextByte += bufferLength;
        buffer = null;
        bufferLength = 0;
        drain();
      }

      if (buffer?.length) {
        pending.push({ data: buffer, byte: nextByte });
        nextByte += buffer.length;
        drain();
      }

      if (!stopped && !localController.signal.aborted) {
        inputDone = true;
        if (!busy && !pending.length && nextByte >= (totalBytes ?? Infinity)) finish();
      }
    } catch (err) {
      if (err.name !== 'AbortError') fail(err);
    }
  }

  return () => {
    stopped = true;
    controller?.abort();
    pending = [];
    videoEl.removeEventListener('timeupdate', onTimeUpdate);
    videoEl.removeEventListener('seeking', onSeeking);
    URL.revokeObjectURL(objectUrl);
    videoEl.removeAttribute('src');
    videoEl.load();
  };
}

function tryPlay(video) {
  const promise = video.play();
  if (promise && typeof promise.catch === 'function') {
    promise.catch(() => {
      // Autoplay gate: keep the frame paused and let the user press play.
      const stage = video.closest('.player-stage');
      const play = stage?.querySelector('.ctrl.primary');
      play?.focus({ preventScroll: true });
      stage?.classList.remove('is-idle');
    });
  }
}

/**
 * Opens the fullscreen player.
 * Direct archive streams get a native <video> with resume + speed + PiP.
 * Everything else runs in a provider iframe with a source picker.
 */
export async function openPlayer(item, preferredProvider = null) {
  if (!item?.id) return;

  rememberShown(item);

  const root = document.getElementById('player-root');
  if (!root) return;
  if (root.childElementCount) closePlayer();

  document.body.classList.add('is-locked');

  let closed = false;
  let video = null;
  let iframe = null;
  let buffering = null;
  let bigPlay = null;
  let sources = [];
  let current = null;
  let saveTimer = null;
  let hideTimer = null;
  let noteTimer = null;
  let clickTimer = null;
  let lastSaved = 0;
  let detachStream = null;
  const listeners = [];

  const on = (target, event, handler, options) => {
    target.addEventListener(event, handler, options);
    listeners.push(() => target.removeEventListener(event, handler, options));
  };

  const stage = el('div', { class: 'player-stage is-idle' });
  const note = el('div', { class: 'player-note' });
  const controls = el('div', { class: 'player-controls' });
  const headMeta = el('span', { class: 'meta', text: '' });

  const closeButton = el('button', {
    class: 'player-close', type: 'button', 'aria-label': 'Close player',
    on: { click: () => closePlayer() },
  }, icon('close'));

  const titleChip = el('div', { class: 'player-title' },
    el('h2', { text: item.title }),
    item.year ? el('span', { class: 'chip subtle', text: String(item.year) }) : null,
  );

  const head = el('div', { class: 'player-head' },
    titleChip,
    headMeta,
    el('div', { class: 'spacer' }),
    closeButton,
  );

  const player = el('div', { class: 'player', role: 'dialog', 'aria-modal': 'true', 'aria-label': `Player — ${item.title}` },
    stage, head, controls, note,
  );
  root.append(player);

  const keysPanel = el('div', { class: 'player-keys', role: 'dialog', 'aria-label': 'Keyboard shortcuts', hidden: true },
    el('div', { class: 'keys-card' },
      el('div', { class: 'keys-head' },
        el('h3', { text: 'Keyboard' }),
        el('button', { class: 'keys-close', type: 'button', 'aria-label': 'Close shortcuts', on: { click: () => toggleKeys(false) } }, icon('close')),
      ),
      el('dl', {},
        ...KEY_ROWS.map(([key, label]) =>
          el('div', { class: 'keys-row' },
            el('dt', {}, el('kbd', { text: key })),
            el('dd', { text: label }),
          )),
      ),
      el('p', { class: 'keys-foot', text: 'Esc closes the player. Embed sources honour only Esc and their own controls.' }),
    ),
  );
  keysPanel.addEventListener('click', (event) => {
    if (event.target === keysPanel) toggleKeys(false);
  });
  player.append(keysPanel);

  function toggleKeys(force) {
    keysPanel.hidden = force === undefined ? !keysPanel.hidden : !force;
  }

  const showStatus = (title, message, spinning = true) => {
    stage.classList.add('is-idle');
    stage.replaceChildren(
      el('div', { class: 'player-status' },
        spinning ? el('div', { class: 'spinner' }) : null,
        el('strong', { text: title }),
        message ? el('p', { text: message }) : null,
      ),
    );
  };

  const flashNote = (message, ttl = 5200) => {
    note.textContent = message;
    note.classList.add('is-visible');
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => note.classList.remove('is-visible'), ttl);
  };

  const persist = () => {
    if (!video || !item.id) return;
    if (!Number.isFinite(video.currentTime) || video.currentTime < 5) return;
    if (Date.now() - lastSaved < SAVE_INTERVAL) return;
    lastSaved = Date.now();
    saveProgress(item.id, video.currentTime, Number.isFinite(video.duration) ? video.duration : current?.duration);
  };

  const closePlayer = () => {
    if (closed) return;
    closed = true;
    if (video) saveProgress(item.id, video.currentTime, Number.isFinite(video.duration) ? video.duration : current?.duration);
    clearInterval(saveTimer);
    clearTimeout(hideTimer);
    clearTimeout(noteTimer);
    clearTimeout(clickTimer);
    for (const off of listeners) off();
    detachStream?.();
    detachStream = null;
    if (video) {
      video.pause();
      video.removeAttribute('src');
      video.load();
    }
    player.remove();
    if (!document.querySelector('.overlay')) document.body.classList.remove('is-locked');
  };

  // Esc closes; arrows scrub; space toggles; f fullscreens.
  const onKey = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      if (!keysPanel.hidden) {
        toggleKeys(false);
        return;
      }
      closePlayer();
      return;
    }
    if (event.target instanceof HTMLInputElement) return;
    if (event.key === '?' || event.key.toLowerCase() === 'h') {
      event.preventDefault();
      toggleKeys();
      return;
    }
    if (!video) return;
    if (event.key === ' ' || event.key.toLowerCase() === 'k') {
      event.preventDefault();
      video.paused ? video.play().catch(() => {}) : video.pause();
    } else if (event.key === 'ArrowRight' || event.key.toLowerCase() === 'l') {
      event.preventDefault();
      video.currentTime = Math.min(video.duration || Infinity, video.currentTime + 10);
      flashNote('+10s', 1100);
    } else if (event.key === 'ArrowLeft' || event.key.toLowerCase() === 'j') {
      event.preventDefault();
      video.currentTime = Math.max(0, video.currentTime - 10);
      flashNote('-10s', 1100);
    } else if (event.key.toLowerCase() === 'm') {
      video.muted = !video.muted;
    } else if (event.key.toLowerCase() === 'f') {
      toggleFullscreen();
    }
  };
  on(document, 'keydown', onKey);

  const toggleFullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else player.requestFullscreen?.().catch(() => {});
  };

  const onFullscreenChange = () => {
    const btn = controls.querySelector('[data-fs]');
    btn?.replaceChildren(icon(document.fullscreenElement ? 'exitFullscreen' : 'fullscreen'));
    btn?.setAttribute('aria-label', document.fullscreenElement ? 'Exit fullscreen' : 'Fullscreen');
  };
  on(document, 'fullscreenchange', onFullscreenChange);

  // Stage behaviour: one click toggles playback, two clicks go fullscreen.
  // The delay stops a double click from also toggling pause twice.
  on(stage, 'click', (event) => {
    if (!video || event.target.closest('button, a, .player-status')) return;
    clearTimeout(clickTimer);
    clickTimer = setTimeout(() => {
      if (!video) return;
      if (video.paused) video.play().catch(() => {});
      else video.pause();
    }, 190);
  });
  on(stage, 'dblclick', (event) => {
    if (!video || event.target.closest('button, a, .player-status')) return;
    clearTimeout(clickTimer);
    toggleFullscreen();
  });

  // Chrome fades while playing; any pointer/key brings it back.
  const wakeChrome = () => {
    player.classList.remove('is-hidden-chrome');
    if (!video || video.paused) return;
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => player.classList.add('is-hidden-chrome'), 2600);
  };
  on(player, 'pointermove', wakeChrome);
  on(player, 'pointerdown', wakeChrome);
  on(document, 'keydown', wakeChrome);

  const buildDirectControls = () => {
    const seekFill = el('div', { class: 'seek-fill' });
    const seekBuffer = el('div', { class: 'seek-buffer' });
    const knob = el('div', { class: 'seek-knob' });
    const track = el('div', { class: 'seek-track' }, seekBuffer, seekFill, knob);
    const seek = el('div', { class: 'seek', role: 'slider', tabindex: '0', 'aria-label': 'Seek', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0' }, track);
    const tip = el('div', { class: 'seek-tip', text: '0:00' });
    const nowLabel = el('span', { class: 'time', text: '0:00' });
    const totalLabel = el('span', { class: 'time', text: formatTime(current?.duration ?? 0) });

    const playButton = el('button', { class: 'ctrl primary', type: 'button', 'aria-label': 'Play' }, icon('play'));
    const muteButton = el('button', { class: 'ctrl', type: 'button', 'aria-label': 'Mute' }, icon('volume'));
    const volume = el('input', { type: 'range', min: '0', max: '1', step: '0.02', 'aria-label': 'Volume' });
    const speedButton = el('button', { class: 'pill-select', type: 'button', 'aria-label': 'Playback speed' }, el('span', { text: '1×' }));
    const pipButton = el('button', { class: 'ctrl', type: 'button', 'aria-label': 'Picture in picture' }, icon('pip'));
    const fsButton = el('button', { class: 'ctrl', type: 'button', 'data-fs': '', 'aria-label': 'Fullscreen' }, icon('fullscreen'));

    const seekTo = (clientX) => {
      const rect = seek.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      if (Number.isFinite(video.duration)) video.currentTime = ratio * video.duration;
    };

    seek.addEventListener('pointerdown', (event) => {
      seek.setPointerCapture(event.pointerId);
      seekTo(event.clientX);
      const move = (moveEvent) => seekTo(moveEvent.clientX);
      const up = () => {
        seek.removeEventListener('pointermove', move);
        seek.removeEventListener('pointerup', up);
      };
      seek.addEventListener('pointermove', move);
      seek.addEventListener('pointerup', up);
    });

    seek.addEventListener('mousemove', (event) => {
      if (!Number.isFinite(video.duration)) return;
      const rect = seek.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
      tip.textContent = formatTime(ratio * video.duration);
      tip.style.left = `${ratio * 100}%`;
    });

    seek.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      const delta = event.key === 'ArrowRight' ? 10 : -10;
      video.currentTime = Math.min(video.duration || Infinity, Math.max(0, video.currentTime + delta));
    });

    volume.value = String(state.prefs.muted ? 0 : state.prefs.volume ?? 1);

    playButton.addEventListener('click', () => {
      if (video.paused) video.play().catch(() => {});
      else video.pause();
    });

    muteButton.addEventListener('click', () => {
      video.muted = !video.muted;
      volume.value = String(video.muted ? 0 : video.volume);
      setVolume(video.muted ? 0 : video.volume, video.muted);
    });

    volume.addEventListener('input', () => {
      const value = Number(volume.value);
      video.volume = value;
      video.muted = value === 0;
      setVolume(value, video.muted);
    });

    speedButton.addEventListener('click', () => {
      const index = SPEEDS.indexOf(video.playbackRate);
      const next = SPEEDS[(index + 1) % SPEEDS.length];
      video.playbackRate = next;
      speedButton.firstChild.textContent = `${next}×`;
      flashNote(`Speed ${next}×`, 1200);
    });

    pipButton.addEventListener('click', async () => {
      try {
        if (document.pictureInPictureElement) await document.exitPictureInPicture();
        else await video.requestPictureInPicture();
      } catch {
        toast('Picture-in-picture is not available here', 'warn');
      }
    });

    fsButton.addEventListener('click', toggleFullscreen);

    const syncPlayIcon = () => {
      playButton.replaceChildren(icon(video.paused ? 'play' : 'pause'));
      playButton.setAttribute('aria-label', video.paused ? 'Play' : 'Pause');
      if (bigPlay) bigPlay.hidden = !video.paused;
    };

    const syncProgress = () => {
      if (!Number.isFinite(video.duration) || !video.duration) return;
      const ratio = video.currentTime / video.duration;
      seekFill.style.width = `${ratio * 100}%`;
      knob.style.left = `${ratio * 100}%`;
      nowLabel.textContent = formatTime(video.currentTime);
      totalLabel.textContent = formatTime(video.duration);
      seek.setAttribute('aria-valuenow', String(Math.round(ratio * 100)));
      if (video.buffered.length) {
        seekBuffer.style.width = `${(video.buffered.end(video.buffered.length - 1) / video.duration) * 100}%`;
      }
    };

    const syncVolumeIcon = () => {
      muteButton.replaceChildren(icon(video.muted || video.volume === 0 ? 'mute' : 'volume'));
      muteButton.setAttribute('aria-label', video.muted ? 'Unmute' : 'Mute');
    };

    on(video, 'play', syncPlayIcon);
    on(video, 'pause', syncPlayIcon);
    on(video, 'timeupdate', syncProgress);
    on(video, 'progress', syncProgress);
    on(video, 'durationchange', syncProgress);
    on(video, 'volumechange', syncVolumeIcon);
    on(video, 'play', wakeChrome);
    on(video, 'pause', () => player.classList.remove('is-hidden-chrome'));

    const setBuffering = (active) => {
      if (!buffering) return;
      buffering.hidden = !active;
    };
    on(video, 'waiting', () => setBuffering(true));
    on(video, 'stalled', () => setBuffering(true));
    on(video, 'seeking', () => setBuffering(true));
    on(video, 'playing', () => setBuffering(false));
    on(video, 'canplay', () => setBuffering(false));
    on(video, 'seeked', () => setBuffering(false));
    on(video, 'error', () => setBuffering(false));

    controls.replaceChildren(
      el('div', { class: 'seek-row' }, nowLabel, seek, tip, totalLabel),
      el('div', { class: 'controls-row' },
        el('button', {
          class: 'ctrl', type: 'button', 'aria-label': 'Back 10 seconds',
          on: { click: () => { video.currentTime = Math.max(0, video.currentTime - 10); } },
        }, icon('back10')),
        playButton,
        el('button', {
          class: 'ctrl', type: 'button', 'aria-label': 'Forward 10 seconds',
          on: { click: () => { video.currentTime = Math.min(video.duration || Infinity, video.currentTime + 10); } },
        }, icon('fwd10')),
        el('div', { class: 'volume-wrap' }, muteButton, volume),
        speedButton,
        el('div', { class: 'ctrl-spacer' }),
        pipButton,
        el('button', { class: 'ctrl', type: 'button', 'aria-label': 'Keyboard shortcuts', on: { click: () => toggleKeys(true) } }, icon('help')),
        fsButton,
      ),
    );

    syncPlayIcon();
    syncProgress();
    syncVolumeIcon();
  };

  const buildEmbedControls = () => {
    controls.replaceChildren(
      el('div', { class: 'controls-row' },
        el('button', {
          class: 'pill-select', type: 'button',
          on: {
            click: () => {
              if (!iframe) return;
              const src = iframe.src;
              iframe.src = src;
            },
          },
        }, el('span', { text: 'Reload' })),
        el('button', { class: 'ctrl', type: 'button', 'aria-label': 'Keyboard shortcuts', on: { click: () => toggleKeys(true) } }, icon('help')),
        el('div', { class: 'ctrl-spacer' }),
        el('button', { class: 'ctrl', type: 'button', 'data-fs': '', 'aria-label': 'Fullscreen', on: { click: toggleFullscreen } }, icon('fullscreen')),
      ),
    );
    player.classList.remove('is-hidden-chrome');
  };

  /**
   * No picker, no dead end: if the direct stream fails the player drops to the
   * first embed on its own. The visitor only ever presses play.
   */
  const fallbackToEmbed = async (message) => {
    const alt = await getSources(item.playId ?? item.id).catch(() => null);
    const embed = (alt?.sources ?? []).find((entry) => entry.kind === 'embed');
    if (embed) {
      sources = [embed];
      toast('Switched to the backup player', 'warn');
      mountSource(0);
      return;
    }
    showStatus('Stream unavailable', message, false);
  };

  const mountSource = (index) => {
    const source = sources[index];
    if (!source) return;
    detachStream?.();
    detachStream = null;
    current = source;
    setSourcePreference(item.id, source.provider);
    stage.replaceChildren();
    controls.replaceChildren();
    player.classList.remove('is-hidden-chrome');
    headMeta.textContent = source.kind !== 'direct'
      ? 'Third-party source'
      : source.provider === 'local'
        ? 'Local file'
        : source.container === 'dash' ? 'Direct stream' : 'Archive · direct';
    clearInterval(saveTimer);
    video = null;
    iframe = null;
    buffering = null;
    bigPlay = null;

    if (source.kind === 'direct') {
      const local = source.provider === 'local';
      video = el('video', {
        playsinline: '',
        preload: 'metadata',
        'aria-label': item.title,
      });
      if (state.prefs.muted) video.muted = true;
      video.volume = state.prefs.muted ? 0 : state.prefs.volume ?? 1;

      // A downloaded transport stream cannot ride a plain <source> — Chrome
      // reports no support for video/mp2t as a src. MSE can demux it, so the
      // file streams in through the feeder instead.
      const container = source.container ?? source.mime ?? '';
      const isTransportStream = /(\.ts|mp2t)/i.test(container);
      const resume = progressFor(item.id);
      const resumePoint = resume && resume.t > 20 && (!resume.duration || resume.t < resume.duration - 40)
        ? resume.t
        : null;

      if (source.container === 'dash' && source.session) {
        detachStream = createDashFeeder(video, source.session, {
          startAt: resumePoint ?? 0,
          onError: (err) => { fallbackToEmbed(err.message); },
        });
      }

      if (isTransportStream) {
        detachStream = createTransportStreamFeeder(video, source.url, {
          duration: source.duration ?? null,
          bytes: source.bytes ?? null,
          startAt: resumePoint,
          onError: () => {
            if (video && !video.error) return;
          },
        });
      }
      if (!detachStream) {
        const source0 = el('source', {
          src: source.url,
          type: isTransportStream ? 'video/mp2t' : 'video/mp4',
        });
        video.append(source0);
      }
      for (const [i, track] of (source.subtitles ?? []).entries()) {
        video.append(el('track', { kind: 'subtitles', label: track.label, src: track.url, srclang: 'en', default: i === 0 ? '' : null }));
      }

      const loader = el('div', { class: 'player-status' },
        el('div', { class: 'spinner' }),
        el('strong', { text: local ? 'Opening local file' : 'Loading stream' }),
        el('p', { text: local ? 'Reading from disk…' : 'Fetching the archive file…' }),
      );

      bigPlay = el('button', {
        class: 'player-bigplay', type: 'button', 'aria-label': 'Play', hidden: true,
        on: { click: () => video.play().catch(() => {}) },
      }, icon('play'));
      buffering = el('div', { class: 'player-buffering', hidden: true }, el('div', { class: 'spinner' }));

      stage.append(video, bigPlay, buffering, loader);

      on(video, 'loadedmetadata', () => {
        loader.remove();
        // The transport-stream feeder places the playhead itself — it knows
        // where the buffer actually starts, which the element does not.
        if (!detachStream && resume && resume.t > 20 && (!video.duration || resume.t < video.duration - 40)) {
          video.currentTime = resume.t;
          flashNote(`Resumed at ${formatTime(resume.t)}`, 3400);
        }
        if (Number.isFinite(video.duration) && video.duration > 0) {
          const kindLabel = local ? 'Local file' : source.container === 'dash' ? 'Direct stream' : 'Archive · direct';
          headMeta.textContent = `${kindLabel} · ${formatTime(video.duration)}`;
        }
        tryPlay(video);
      }, { once: true });

      on(video, 'error', () => {
        fallbackToEmbed('The archive file did not respond.');
      });

      saveTimer = setInterval(persist, SAVE_INTERVAL);
      on(video, 'ended', () => saveProgress(item.id, 0, video.duration));
      buildDirectControls();
      stage.classList.remove('is-idle');
      wakeChrome();
      return;
    }

    iframe = el('iframe', {
      src: source.url,
      title: `${item.title} — ${source.label}`,
      allow: 'autoplay; fullscreen; encrypted-media; picture-in-picture',
      allowfullscreen: '',
      referrerpolicy: 'origin',
      loading: 'eager',
      // Every ad these embeds run needs one of the capabilities left out here:
      // window.open for popunders, top-level navigation for redirect hijacks,
      // modals for the "your player is out of date" bait. What is left is what
      // a video player actually uses, so the feature still plays.
      sandbox: [
        'allow-scripts',
        'allow-same-origin',
        'allow-forms',
        'allow-presentation',
        'allow-orientation-lock',
        'allow-pointer-lock',
      ].join(' '),
    });
    stage.append(iframe);
    stage.classList.remove('is-idle');
    buildEmbedControls();
    flashNote('Popups and redirects are blocked in this frame. If the player stays black, switch source.', 5200);
    on(iframe, 'load', () => flashNote('Source loaded. If playback does not start, try another source.', 3600));
  };

  /* ------------------------------ boot -------------------------------- */

  showStatus('Preparing stream', `Preparing “${item.title}”`);
  headMeta.textContent = 'preparing…';

  // The server decides everything: a local copy, a live direct stream, or one
  // embed. There is no source list in the player and nothing for the visitor
  // to pick.
  const playId = item.playId ?? item.id;
  const payload = await getPlay(playId).catch((err) => ({ error: err }));

  if (payload.error) {
    showStatus('Could not start playback', payload.error.message, false);
    stage.append(el('button', {
      class: 'btn btn-ghost btn-mini', type: 'button',
      on: { click: () => { closePlayer(); openPlayer(item, preferredProvider); } },
    }, 'Retry'));
    return;
  }

  const source = payload.source;
  if (!source) {
    showStatus('No stream yet', 'This title has no playable source right now.', false);
    return;
  }

  // A browser without HEVC MSE cannot take the direct stream; drop to the
  // embed before mounting instead of after a black frame.
  if (source.container === 'dash' && source.session && !canPlayDash(source.session)) {
    await fallbackToEmbed('This browser cannot decode the direct stream.');
    return;
  }

  sources = [source];
  mountSource(0);
}

/**
 * DASH needs MSE and a decoder for both tracks. HEVC is the common case on the
 * providers and Chrome only exposes it where the OS can decode it, so the check
 * is made before the source is offered rather than after it fails.
 */
function canPlayDash(session) {
  if (typeof MediaSource === 'undefined') return false;
  try {
    return MediaSource.isTypeSupported(session.video.mime) && MediaSource.isTypeSupported(session.audio.mime);
  } catch {
    return false;
  }
}

export function closePlayer() {
  document.querySelector('#player-root .player-close')?.click();
}
