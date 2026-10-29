import { getDashVariant, getHlsVariant, getPlay, getSources, getSubtitles } from './api.js';
import { createDashFeeder } from './dash.js';
import { createHlsFeeder } from './hls.js';
import {
  CAPTION_SIZES,
  captionOffsetFor,
  progressFor,
  rememberShown,
  saveProgress,
  setCaptionOffsetFor,
  setCaptionSize,
  setVolume,
  state,
} from './state.js';
import { el, formatTime, icon, toast } from './ui.js';

const SPEEDS = [1, 1.25, 1.5, 0.75, 1.75, 2];
const SAVE_INTERVAL = 5_000;

const KEY_ROWS = [
  ['Space / K', 'Play or pause'],
  ['E', 'Open episode seasons'],
  ['← / →', 'Seek 10 seconds'],
  ['J / L', 'Seek 10 seconds'],
  ['M', 'Mute'],
  ['C', 'Subtitles on or off'],
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
  let basePts = null;        // media time of the first appended frame
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
        basePts = first;
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

  const handle = () => {
    stopped = true;
    controller?.abort();
    pending = [];
    videoEl.removeEventListener('timeupdate', onTimeUpdate);
    videoEl.removeEventListener('seeking', onSeeking);
    URL.revokeObjectURL(objectUrl);
    videoEl.removeAttribute('src');
    videoEl.load();
  };

  /**
   * A raw transport stream carries absolute PTS, so its timeline rarely starts
   * at zero, and the element will not seek outside what it has buffered. The
   * player asks for a position in film time; this translates it onto the
   * stream's own clock and lets `jumpTo` re-open the byte range for it.
   */
  handle.seek = (time) => {
    if (stopped) return;
    const offset = Math.max(0, Number(time) || 0);
    jumpTo((basePts ?? 0) + offset);
  };

  return handle;
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
 * Direct DASH streams get a native <video> fed by Media Source Extensions, with
 * resume, speed and PiP. The single fallback is a provider iframe, mounted only
 * when the direct path fails.
 */
export async function openPlayer(item) {
  if (!item?.id) return;

  rememberShown(item);

  const root = document.getElementById('player-root');
  if (!root) return;
  // A player already open (the detail page auto-plays, then the visitor presses
  // play again) gets closed first. The button is used rather than the local
  // handler because that handler is declared further down this function.
  if (root.childElementCount) root.querySelector('.player-close')?.click();

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
  // A rendition switch tears down one MediaSource and builds another. Chrome
  // fires an error on the element for the revoked object URL, which must not be
  // mistaken for the new stream failing — the feeders report real failures
  // themselves.
  let switching = false;
  // HLS hands back a teardown function, DASH an object with destroy(); both
  // mean stop fetching and release the element.
  const detachFeeder = (handle) => {
    if (!handle) return;
    if (typeof handle === 'function') handle();
    else handle.destroy?.();
  };

  /**
   * Every seek in this player goes through here.
   *
   * Assigning `video.currentTime` directly only works inside the buffered
   * window: MSE reports the buffered ranges as `seekable`, so anything outside
   * them is clamped to the nearest edge and the playhead never moves — a rewind
   * past the oldest buffered second did nothing at all. The feeder knows how to
   * rebuild around a distant target, so the target is handed to it instead of
   * to the element.
   */
  const seekToTime = (time, noteText = null) => {
    const duration = Number.isFinite(video?.duration) && video.duration > 0
      ? video.duration
      : Number.isFinite(current?.duration) && current.duration > 0 ? current.duration : null;
    const raw = Number(time);
    const target = Math.max(0, duration ? Math.min(duration, Number.isFinite(raw) ? raw : 0) : (Number.isFinite(raw) ? raw : 0));
    if (detachStream?.seek) detachStream.seek(target);
    else if (video) {
      try { video.currentTime = target; } catch { /* not seekable yet */ }
    }
    if (noteText) flashNote(noteText, 1100);
    return target;
  };
  let qualityMenu = null;
  let qualityText = null;
  let captionMenu = null;
  let captionSlot = null;
  let captionTracks = [];
  let activeCaption = null;
  let captionSize = CAPTION_SIZES.includes(state.prefs.captionSize) ? state.prefs.captionSize : 'middle';
  let captionOffset = Number(state.prefs.captionOffset) || 0;
  let captionToken = 0;
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

  /* ------------------------------ episodes ------------------------------ */

  /**
   * The season browser, inside the player.
   *
   * A show opened from a card starts playing straight away — no episode picker
   * in the way, which is what makes opening a series one click. That used to
   * also mean the season list was unreachable, because the player covered the
   * detail sheet that carries it. The drawer puts every season and every
   * episode one tap away, and switching episodes re-opens playback in place
   * instead of closing the player.
   */
  const seasons = Array.isArray(item.seasons) ? item.seasons : [];
  const episodeParts = /^tv:(\d+):(\d+):(\d+)$/.exec(String(item.playId ?? ''));
  let currentEpisode = episodeParts
    ? { season: Number(episodeParts[2]), number: Number(episodeParts[3]) }
    : null;
  let episodesPanel = null;
  let episodesButton = null;
  let episodesLauncher = null;

  const episodeLabel = () => {
    if (!currentEpisode) return 'Episodes';
    return `S${currentEpisode.season}E${currentEpisode.number}`;
  };

  const paintEpisodeButton = () => {
    const label = `Episodes · ${episodeLabel()}`;
    const aria = `Episodes — currently season ${currentEpisode?.season ?? 1} episode ${currentEpisode?.number ?? 1}`;
    for (const button of [episodesButton, episodesLauncher]) {
      if (!button) continue;
      button.replaceChildren(icon('list'), el('span', { text: label }));
      button.setAttribute('aria-label', aria);
    }
  };

  if (seasons.length) {
    episodesButton = el('button', {
      class: 'pill-select episodes-toggle', type: 'button', 'aria-label': 'Episodes',
      on: { click: () => toggleEpisodes() },
    });
    paintEpisodeButton();

    const tabs = el('div', { class: 'season-tabs', role: 'tablist', 'aria-label': 'Seasons' });
    const list = el('div', { class: 'episode-list' });

    const paintSeason = (number) => {
      const season = seasons.find((entry) => entry.number === number) ?? seasons[0];
      for (const tab of tabs.querySelectorAll('.season-tab')) {
        const active = Number(tab.dataset.season) === season.number;
        tab.classList.toggle('is-active', active);
        tab.setAttribute('aria-selected', active ? 'true' : 'false');
      }
      list.replaceChildren(...season.episodes.map((episode) => {
        const active = currentEpisode?.season === season.number && currentEpisode?.number === episode.number;
        return el('button', {
          type: 'button',
          class: active ? 'episode is-current' : 'episode',
          on: { click: () => { void switchEpisode(season.number, episode); } },
        },
          el('span', { class: 'episode-num', text: String(episode.number).padStart(2, '0') }),
          el('span', { class: 'episode-body' },
            el('span', { class: 'episode-name', text: episode.name }),
            episode.airdate
              ? el('span', { class: 'episode-meta', text: String(episode.airdate).slice(0, 4) })
              : null,
          ),
          active ? el('span', { class: 'episode-now', text: 'Playing' }) : null,
        );
      }));
      list.scrollTop = 0;
    };

    for (const season of seasons) {
      tabs.append(el('button', {
        class: 'season-tab', type: 'button', role: 'tab',
        'data-season': String(season.number),
        'aria-selected': 'false',
        on: { click: () => paintSeason(season.number) },
      }, `Season ${season.number}`));
    }

    episodesPanel = el('div', { class: 'player-episodes', role: 'dialog', 'aria-label': 'Episodes', hidden: true },
      el('div', { class: 'episodes-card' },
        el('div', { class: 'episodes-head' },
          el('div', {},
            el('h3', { text: item.title.split(' — ')[0] }),
            el('p', { class: 'episodes-sub', text: `${seasons.length} seasons · ${seasons.reduce((sum, season) => sum + season.episodes.length, 0)} episodes` }),
          ),
          el('button', { class: 'keys-close', type: 'button', 'aria-label': 'Close episodes', on: { click: () => toggleEpisodes(false) } }, icon('close')),
        ),
        tabs,
        list,
      ),
    );
    episodesPanel.addEventListener('click', (event) => {
      if (event.target === episodesPanel) toggleEpisodes(false);
    });
    player.append(episodesPanel);
    paintSeason(currentEpisode?.season ?? seasons[0].number);

    // Keep one launcher visible even when the playback chrome fades away. The
    // bottom control is convenient while paused; this one makes every season
    // discoverable during playback and on embed fallbacks.
    episodesLauncher = el('button', {
      class: 'episodes-launcher', type: 'button',
      title: 'Seasons and episodes',
      'aria-label': 'Seasons and episodes',
      on: { click: () => toggleEpisodes() },
    });
    player.append(episodesLauncher);
    paintEpisodeButton();
  }

  function toggleEpisodes(force) {
    if (!episodesPanel) return;
    const next = force === undefined ? episodesPanel.hidden : Boolean(force);
    episodesPanel.hidden = !next;
    if (next) closeQuality();
  }

  /**
   * Move the player to another episode without closing it.
   *
   * The progress of the episode being left is written first — otherwise a jump
   * at 40 minutes would lose the resume point — and the caption list is dropped
   * because it belongs to the episode, not the show.
   */
  async function switchEpisode(seasonNumber, episode) {
    const nextId = `${item.id}:${seasonNumber}:${episode.number}`;
    if (nextId === item.playId) {
      toggleEpisodes(false);
      return;
    }
    if (video) saveProgress(item.playId ?? item.id, video.currentTime, Number.isFinite(video.duration) ? video.duration : current?.duration);

    currentEpisode = { season: seasonNumber, number: episode.number };
    item.playId = nextId;
    item.title = `${seasonsTitle()} — S${seasonNumber}E${episode.number} · ${episode.name}`;
    titleChip.querySelector('h2').textContent = item.title;
    paintEpisodeButton();
    toggleEpisodes(false);

    detachFeeder(detachStream);
    detachStream = null;
    video = null;
    iframe = null;
    captionTracks = [];
    activeCaption = null;
    renderCaptionButton();
    await startPlayback(nextId);
  }

  const seasonsTitle = () => String(item.title ?? '').split(' — ')[0];

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

  /* ------------------------------ quality ------------------------------ */

  qualityMenu = el('div', {
    class: 'source-menu', role: 'dialog', 'aria-label': 'Video quality', hidden: true,
  });
  player.append(qualityMenu);

  const closeQuality = () => { qualityMenu.hidden = true; };

  const qualityVariants = () => {
    const renditions = current?.renditions;
    if (Array.isArray(renditions) && renditions.length) return renditions;
    const list = current?.session?.variants;
    return Array.isArray(list) ? list : [];
  };

  const openQuality = () => {
    const variants = qualityVariants();
    if (variants.length < 2) return;
    const active = current?.session?.variant ?? 0;

    qualityMenu.replaceChildren(
      el('h3', { text: 'Quality' }),
      ...variants.map((variant) => el('button', {
        type: 'button',
        class: variant.index === active ? 'is-active' : '',
        on: {
          click: () => {
            closeQuality();
            void switchQuality(variant.index);
          },
        },
      },
        el('div', { class: 'quality-item' },
          el('span', { text: variant.label }),
          variant.bandwidth
            ? el('small', { text: `${(variant.bandwidth / 1_000_000).toFixed(1)} Mbps` })
            : null,
        ),
        variant.index === active ? el('span', { class: 'tick', text: '✓' }) : null,
      )),
    );
    qualityMenu.hidden = false;
  };

  /**
   * Swap rendition without losing the playhead.
   *
   * The server pre-opens every rendition, so the common path is a local swap:
   * the session object changes, the feeder is rebuilt at the current time, and
   * nothing touches the network — which matters, because the feeder owns the
   * browser's six-connection pool for the whole film.
   */
  const switchQuality = async (index) => {
    const session = current?.session;
    if (!session?.sid || !video) return;
    if (index === session.variant) return;

    const variant = qualityVariants()[index];
    const label = variant?.label ?? 'auto';
    const container = current.container;
    const at = video.currentTime;
    const wasPlaying = !video.paused;

    const mountAt = (target, when) => {
      const feeder = container === 'dash'
        ? createDashFeeder(video, target, { startAt: when, onError: (err) => { fallbackToEmbed(err.message); } })
        : createHlsFeeder(video, target, { startAt: when, onError: (err) => { fallbackToEmbed(err.message); } });
      if (!feeder) {
        fallbackToEmbed('This browser cannot decode that quality.');
        return false;
      }
      detachStream = feeder;
      if (wasPlaying) video.play().catch(() => {});
      return true;
    };

    const apply = (next, quality) => {
      current = { ...current, session: next, quality };
      switching = true;
      // Drop the old source before the old MediaSource is released: an element
      // still pointing at a revoked object URL raises MEDIA_ERR_SRC_NOT_SUPPORTED.
      try { video.pause(); } catch { /* already paused */ }
      try { video.removeAttribute('src'); video.load(); } catch { /* no source yet */ }
      detachFeeder(detachStream);
      detachStream = null;
      if (!mountAt(next, at)) {
        switching = false;
        return;
      }
      setTimeout(() => { switching = false; }, 1600);
      if (qualityText) qualityText.textContent = current.quality;
      flashNote(`Quality: ${current.quality}`, 1800);
    };

    const rendition = current.renditions?.[index];
    if (rendition?.session) {
      flashNote(`Switching to ${label}…`, 2000);
      apply(rendition.session, rendition.label ?? label);
      return;
    }

    // No pre-opened ladder (a single-rendition stream): ask the server, and
    // stop the feeder first so the request is not queued behind segments.
    flashNote(`Switching to ${label}…`, 8000);
    detachFeeder(detachStream);
    detachStream = null;

    let next;
    try {
      const payload = container === 'dash'
        ? await getDashVariant(session.sid, index)
        : await getHlsVariant(session.sid, index);
      next = payload.session;
    } catch (err) {
      if (closed || !video) return;
      flashNote(err?.message ?? 'Could not switch quality', 4200);
      mountAt(session, at);
      return;
    }
    if (closed || !video || !next) return;

    apply(next, next.quality ?? label);
  };

  /* ------------------------------ captions ------------------------------ */

  /**
   * Captions.
   *
   * The stream carries none — no text adaptation set in DASH, no `EXT-X-MEDIA`
   * in HLS — so the list comes from the subtitle index and every track is
   * converted to WebVTT on the server. The menu is built the moment the list
   * lands, which is usually well before the first frame: the caption request
   * runs alongside the play request rather than after it.
   */
  captionMenu = el('div', {
    class: 'source-menu caption-menu', role: 'dialog', 'aria-label': 'Subtitles', hidden: true,
  });
  player.append(captionMenu);

  const closeCaptions = () => { captionMenu.hidden = true; };

  const activeLabel = () => {
    if (!activeCaption) return 'Off';
    return captionTracks.find((entry) => entry.lang === activeCaption)?.label ?? activeCaption;
  };

  const renderCaptionButton = () => {
    if (!captionSlot) return;
    if (!captionTracks.length) {
      captionSlot.replaceChildren();
      return;
    }
    captionSlot.replaceChildren(el('button', {
      class: activeCaption ? 'pill-select is-on' : 'pill-select',
      type: 'button', 'aria-label': 'Subtitles',
      on: {
        click: () => {
          if (captionMenu.hidden) openCaptions();
          else closeCaptions();
        },
      },
    },
      icon('cc'),
      el('span', { text: activeCaption ? activeCaption.toUpperCase() : 'CC' })));
  };

  /**
   * Caption sync.
   *
   * Cues are timed for one release and the copy being played may be another, so
   * every cue can be nudged. `__baseStart`/`__baseEnd` keep the times the file
   * shipped with — without them each nudge would stack on the last one and the
   * track would drift away for good. The track loads asynchronously, so the
   * shift runs again on `load`.
   */
  const shiftCues = (track) => {
    const list = track?.cues;
    if (!list) return;
    for (const cue of list) {
      if (cue.__baseStart === undefined) {
        cue.__baseStart = cue.startTime;
        cue.__baseEnd = cue.endTime;
      }
      const start = cue.__baseStart + captionOffset;
      const end = cue.__baseEnd + captionOffset;
      if (end <= 0.2) continue;
      try {
        cue.startTime = Math.max(0, start);
        cue.endTime = Math.max(0.2, end);
      } catch {
        // the browser refused a re-timed cue; the file's own timing stays
      }
    }
  };

  const showingTrack = () => {
    if (!video) return null;
    const node = [...video.querySelectorAll('track')].find((entry) => entry.track?.mode === 'showing');
    return node?.track ?? null;
  };

  const captionKey = (lang) => `${item.playId ?? item.id}:${lang}`;

  /**
   * Apply the sync shift as soon as a track's cues exist.
   *
   * `track.cues` is null until the VTT has parsed, and the `load` event that
   * announces it fires on the element, not on the TextTrack — attaching to the
   * wrong object meant a track turned on with a non-zero offset played the
   * file's own timing for the rest of the episode. Both paths are wired, and a
   * short poll covers a track that was already cached before the listener
   * landed.
   */
  const shiftWhenReady = (node, attempt = 0) => {
    if (!node) return;
    const track = node.track;
    if (track?.cues?.length) {
      shiftCues(track);
      return;
    }
    if (attempt >= 40) return;
    setTimeout(() => shiftWhenReady(node, attempt + 1), 100);
  };

  /**
   * Turn one language on, or all of them off.
   *
   * A `<track>` is appended the first time a language is chosen and kept
   * afterwards, so switching back is a mode flip rather than a refetch. The
   * element is `disabled` for every other track — two showing at once stacks
   * two sets of cues on the same frame.
   */
  const applyCaption = (track) => {
    if (!video) return;
    const lang = track?.lang ?? null;

    if (lang) {
      // Timing corrections belong to this title and language. Switching from
      // one episode or language must never carry the previous track's offset.
      captionOffset = captionOffsetFor(captionKey(lang));
      let node = [...video.querySelectorAll('track')].find((entry) => entry.dataset.lang === lang);
      if (!node) {
        node = el('track', {
          kind: 'subtitles',
          label: track.label,
          srclang: track.code || 'en',
          src: track.url,
          dataset: { lang },
        });
        video.append(node);
      }
      for (const entry of video.querySelectorAll('track')) {
        entry.track.mode = entry === node ? 'showing' : 'disabled';
      }
      // Cues parse asynchronously and the event fires on the element, so both
      // the listener and a poll are wired — see `shiftWhenReady`.
      node.addEventListener('load', () => shiftCues(node.track), { once: true });
      shiftWhenReady(node);
    } else {
      for (const entry of video.querySelectorAll('track')) entry.track.mode = 'disabled';
    }

    activeCaption = lang;
    renderCaptionButton();
    flashNote(lang ? `Subtitles: ${track.label}` : 'Subtitles off', 1800);
  };

  const applyCaptionOffset = (value) => {
    captionOffset = Math.max(-30, Math.min(30, Math.round(Number(value) * 10) / 10));
    setCaptionOffsetFor(activeCaption ? captionKey(activeCaption) : null, captionOffset);
    shiftCues(showingTrack());
    if (!captionMenu.hidden) openCaptions();
  };

  /**
   * Caption size.
   *
   * The cue lives in the video's shadow tree, so the only handle the page has on
   * it is the `::cue` pseudo-element. The size lands as an attribute on the
   * player root and the stylesheet carries one rule per size, each expressed in
   * `em` — that multiplies the browser's own cue size instead of replacing it,
   * so the text keeps its relationship to the frame at any window size.
   */
  const paintCaptionSize = () => {
    player.dataset.cue = captionSize;
  };

  const applyCaptionSize = (size) => {
    captionSize = CAPTION_SIZES.includes(size) ? size : 'middle';
    paintCaptionSize();
    setCaptionSize(captionSize);
    if (!captionMenu.hidden) openCaptions();
  };

  paintCaptionSize();

  const openCaptions = () => {
    if (!captionTracks.length) return;
    closeQuality();

    const row = (track) => {
      const active = (activeCaption ?? null) === (track?.lang ?? null);
      return el('button', {
        type: 'button',
        class: active ? 'is-active' : '',
        on: { click: () => { closeCaptions(); applyCaption(track); } },
      },
        el('div', { class: 'quality-item' },
          el('span', { text: track ? track.label : 'Off' }),
          track ? el('small', { text: track.lang.toUpperCase() }) : null),
        active ? el('span', { class: 'tick', text: '✓' }) : null);
    };

    // Twenty-seven languages on an episode is a wall of rows, so the list gets
    // a filter as soon as it is longer than a glance.
    const list = el('div', { class: 'caption-list' });
    const paint = (query) => {
      const needle = String(query ?? '').trim().toLowerCase();
      const matches = needle
        ? captionTracks.filter((entry) =>
            String(entry.label ?? '').toLowerCase().includes(needle)
            || String(entry.lang ?? '').toLowerCase().includes(needle))
        : captionTracks;
      list.replaceChildren(row(null), ...matches.map(row));
      if (!matches.length) {
        list.append(el('p', { class: 'caption-empty', text: 'No language matches that.' }));
      }
    };

    const search = captionTracks.length > 8
      ? el('input', {
          class: 'caption-search', type: 'search', spellcheck: 'false',
          placeholder: `Search ${captionTracks.length} languages`,
          'aria-label': 'Filter subtitle languages',
          on: { input: (event) => paint(event.target.value) },
        })
      : null;

    // Size sits above the languages and works whether a track is on or not, so
    // the choice can be made before the first line of dialogue.
    const sizeRow = el('div', { class: 'caption-size' },
      el('span', { class: 'caption-size-label', text: 'Size' }),
      el('div', { class: 'caption-size-group', role: 'group', 'aria-label': 'Subtitle size' },
        ...CAPTION_SIZES.map((size) => el('button', {
          type: 'button',
          class: size === captionSize ? 'is-active' : '',
          'aria-pressed': size === captionSize ? 'true' : 'false',
          on: { click: () => applyCaptionSize(size) },
        }, el('span', { text: size[0].toUpperCase() + size.slice(1) })))));

    const offsetText = captionOffset === 0
      ? 'Auto'
      : `${captionOffset > 0 ? '+' : ''}${captionOffset.toFixed(1)}s`;
    const offsetValue = el('button', {
      type: 'button', class: 'caption-offset-value',
      'aria-label': 'Reset subtitle timing to automatic',
      on: { click: () => applyCaptionOffset(0) },
    }, el('span', { text: offsetText }));

    const offsetRow = el('div', { class: 'caption-size caption-sync-row' },
      el('span', { class: 'caption-size-label', text: 'Sync · 0.1s' }),
      el('div', { class: 'caption-offset-group', role: 'group', 'aria-label': 'Subtitle sync' },
        el('button', { type: 'button', 'aria-label': 'Move captions 0.5 seconds earlier', on: { click: () => applyCaptionOffset(captionOffset - 0.5) } }, el('span', { text: '−0.5s' })),
        el('button', { type: 'button', 'aria-label': 'Move captions 0.1 seconds earlier', on: { click: () => applyCaptionOffset(captionOffset - 0.1) } }, el('span', { text: '−0.1s' })),
        offsetValue,
        el('button', { type: 'button', 'aria-label': 'Move captions 0.1 seconds later', on: { click: () => applyCaptionOffset(captionOffset + 0.1) } }, el('span', { text: '+0.1s' })),
        el('button', { type: 'button', 'aria-label': 'Move captions 0.5 seconds later', on: { click: () => applyCaptionOffset(captionOffset + 0.5) } }, el('span', { text: '+0.5s' }))));

    paint('');
    captionMenu.replaceChildren(
      el('h3', { text: `Subtitles · ${captionTracks.length} languages` }),
      sizeRow,
      offsetRow,
      search,
      list,
    );
    captionMenu.hidden = false;
    search?.focus();
  };

  /**
   * Ask for the list. A stale answer is dropped: the player may have moved to
   * another title, or to an embed that cannot carry a text track at all.
   */
  const loadCaptions = async (id, duration = null) => {
    const token = ++captionToken;
    captionTracks = [];
    activeCaption = null;
    renderCaptionButton();
    if (!id) return;

    const data = await getSubtitles(id, duration).catch(() => null);
    if (closed || token !== captionToken) return;

    captionTracks = Array.isArray(data?.tracks) ? data.tracks : [];
    renderCaptionButton();
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
    detachFeeder(detachStream);
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
      if (episodesPanel && !episodesPanel.hidden) {
        toggleEpisodes(false);
        return;
      }
      if (!qualityMenu.hidden) {
        closeQuality();
        return;
      }
      if (!captionMenu.hidden) {
        closeCaptions();
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
    if (event.key.toLowerCase() === 'e' && episodesPanel) {
      event.preventDefault();
      toggleEpisodes();
      return;
    }
    if (!video) return;
    if (event.key === ' ' || event.key.toLowerCase() === 'k') {
      event.preventDefault();
      video.paused ? video.play().catch(() => {}) : video.pause();
    } else if (event.key === 'ArrowRight' || event.key.toLowerCase() === 'l') {
      event.preventDefault();
      seekToTime(video.currentTime + 10, '+10s');
    } else if (event.key === 'ArrowLeft' || event.key.toLowerCase() === 'j') {
      event.preventDefault();
      seekToTime(video.currentTime - 10, '-10s');
    } else if (event.key.toLowerCase() === 'm') {
      video.muted = !video.muted;
    } else if (event.key.toLowerCase() === 'c') {
      event.preventDefault();
      if (!captionTracks.length) return;
      if (activeCaption) applyCaption(null);
      else applyCaption(captionTracks[0]);
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
    closeQuality();
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
    // The quality ladder is whatever the provider declared. A local copy holds
    // one rendition, so the button only exists when there is a choice.
    const variants = qualityVariants();
    qualityText = null;
    const qualityButton = variants.length > 1
      ? el('button', {
          class: 'pill-select', type: 'button', 'aria-label': 'Video quality',
          on: {
            click: () => {
              if (qualityMenu.hidden) openQuality();
              else closeQuality();
            },
          },
        },
          qualityText = el('span', { text: current?.session?.quality ?? 'auto' }),
          icon('down'))
      : null;
    const pipButton = el('button', { class: 'ctrl', type: 'button', 'aria-label': 'Picture in picture' }, icon('pip'));
    const fsButton = el('button', { class: 'ctrl', type: 'button', 'data-fs': '', 'aria-label': 'Fullscreen' }, icon('fullscreen'));

    const scrubTo = (clientX) => {
      const rect = seek.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      const total = Number.isFinite(video.duration) && video.duration > 0
        ? video.duration
        : Number(current?.duration) > 0 ? Number(current.duration) : 0;
      if (total > 0) seekToTime(ratio * total);
    };

    seek.addEventListener('pointerdown', (event) => {
      seek.setPointerCapture(event.pointerId);
      scrubTo(event.clientX);
      const move = (moveEvent) => scrubTo(moveEvent.clientX);
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
      seekToTime(video.currentTime + (event.key === 'ArrowRight' ? 10 : -10));
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
          on: { click: () => seekToTime(video.currentTime - 10, '-10s') },
        }, icon('back10')),
        playButton,
        el('button', {
          class: 'ctrl', type: 'button', 'aria-label': 'Forward 10 seconds',
          on: { click: () => seekToTime(video.currentTime + 10, '+10s') },
        }, icon('fwd10')),
        el('div', { class: 'volume-wrap' }, muteButton, volume),
        speedButton,
        qualityButton,
        episodesButton,
        captionSlot = el('span', { class: 'caption-slot' }),
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
        // Direct playback can fall back to an iframe. Keep the season drawer
        // available there too; otherwise a failed stream would strand a series
        // on the episode that happened to start first.
        episodesButton,
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
    detachFeeder(detachStream);
    detachStream = null;
    current = source;
    // The server pre-opens every rendition and hangs the ladder on the session;
    // hoist it onto the source so a switch never needs a request.
    if (source.session?.renditions?.length) current = { ...source, renditions: source.session.renditions };
    stage.replaceChildren();
    controls.replaceChildren();
    // Captions belong to the title, not the mount: fetch once, keep the list
    // for the whole session so a quality switch or an embed fallback does not
    // have to ask again.
    if (!captionTracks.length) {
      const subtitleDuration = Number(source.duration ?? source.session?.duration ?? 0);
      void loadCaptions(item.playId ?? item.id, subtitleDuration);
    }
    else renderCaptionButton();
    player.classList.remove('is-hidden-chrome');
    headMeta.textContent = source.kind !== 'direct'
      ? 'Third-party source'
      : source.provider === 'local'
        ? 'Local file'
        : /^(dash|hls|hls-fmp4)$/.test(source.container ?? '') ? 'Direct stream' : 'Archive · direct';
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

      // HLS arrives muxed — one segment list, one SourceBuffer. The feeder owns
      // the read-ahead window and the seek restart; the element only plays.
      if ((source.container === 'hls' || source.container === 'hls-fmp4') && source.session) {
        detachStream = createHlsFeeder(video, source.session, {
          startAt: resumePoint ?? 0,
          onError: (err) => { fallbackToEmbed(err.message); },
        });
        if (!detachStream) {
          fallbackToEmbed('This browser cannot decode the direct stream.');
          return;
        }
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

      const loader = el('div', { class: 'player-status' },
        el('div', { class: 'spinner' }),
        el('strong', { text: local ? 'Opening local copy' : 'Loading stream' }),
        el('p', { text: local ? 'Reading from disk…' : 'Buffering the first segments…' }),
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
          const kindLabel = local ? 'Local copy' : /^(dash|hls|hls-fmp4)$/.test(source.container ?? '') ? 'Direct stream' : 'Direct file';
          headMeta.textContent = `${kindLabel} · ${formatTime(video.duration)}`;
        }
        tryPlay(video);
      }, { once: true });

      on(video, 'error', () => {
        if (switching) return;
        fallbackToEmbed('The stream did not respond.');
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
      // No sandbox attribute: providers refuse to boot their player inside one
      // ("this content can't be embedded in a sandboxed frame"), and this is the
      // last-resort path — a frame that will not start is worse than one that
      // can open a popup. The direct stream above never reaches this branch.
    });
    stage.append(iframe);
    stage.classList.remove('is-idle');
    buildEmbedControls();
    on(iframe, 'load', () => flashNote('Backup player loaded.', 2600));
  };

  /* ------------------------------ boot -------------------------------- */

  /**
   * Ask the server for one playable source and mount it.
   *
   * Separate from the boot below because the episode drawer re-enters it: an
   * episode switch is the same request with a different id, and the player
   * stays open across it.
   */
  async function startPlayback(playId) {
    showStatus('Preparing stream', `Preparing “${item.title}”`);
    headMeta.textContent = 'preparing…';

    // The server decides everything: a local copy, a live direct stream, or one
    // embed. There is no source list in the player and nothing for the visitor
    // to pick.
    const payload = await getPlay(playId).catch((err) => ({ error: err }));
    if (closed) return;

    if (payload.error) {
      showStatus('Could not start playback', payload.error.message, false);
      stage.append(el('button', {
        class: 'btn btn-ghost btn-mini', type: 'button',
        on: { click: () => { closePlayer(); openPlayer(item); } },
      }, 'Retry'));
      return;
    }

    const source = payload.source;
    if (!source) {
      showStatus('No stream yet', 'This title has no playable source right now.', false);
      return;
    }

    // A browser without the right MSE codec cannot take the direct stream; drop
    // to the embed before mounting instead of after a black frame.
    if (source.session && !canPlaySession(source)) {
      await fallbackToEmbed('This browser cannot decode the direct stream.');
      return;
    }

    sources = [source];
    mountSource(0);
  }

  await startPlayback(item.playId ?? item.id);
}

/**
 * MSE needs a SourceBuffer type the decoder accepts. HEVC is the common case on
 * the providers and Chrome only exposes it where the OS can decode it, so the
 * check is made before the source is offered rather than after it fails. HLS
 * asks the same question about its muxed container.
 */
function canPlaySession(source) {
  if (typeof MediaSource === 'undefined') return false;
  const session = source.session;
  try {
    if (source.container === 'dash') {
      return MediaSource.isTypeSupported(session.video.mime) && MediaSource.isTypeSupported(session.audio.mime);
    }
    if (source.container === 'hls' || source.container === 'hls-fmp4') {
      const list = Array.isArray(session.mimes) && session.mimes.length ? session.mimes : [session.mime];
      return list.some((type) => MediaSource.isTypeSupported(type));
    }
    return true;
  } catch {
    return false;
  }
}

export function closePlayer() {
  document.querySelector('#player-root .player-close')?.click();
}
