/**
 * HLS through Media Source Extensions.
 *
 * The DASH feeder takes two tracks and a numbered segment template. HLS gives a
 * playlist instead: one URL per few seconds, audio and video already muxed, and
 * durations that vary segment by segment. So this feeder keeps a time→index map
 * built from the playlist, fetches segments in order through the server's proxy,
 * and appends them one at a time.
 *
 * Transport-stream playlists go into a `video/mp2t` SourceBuffer; fMP4 playlists
 * prepend their init segment and use `video/mp4`. Both are appended raw — the
 * browser demuxes, so nothing here needs a remuxer.
 *
 * The buffer is kept to a bounded look-ahead. Appending a whole film makes Chrome
 * evict the head of the timeline, which breaks seeking and sometimes playback
 * itself.
 */

const LOOKAHEAD = 40;      // seconds of media kept ahead of the playhead
const AHEAD = 3;           // segment fetches kept in flight
const MAX_RETRIES = 3;
const SETTLE_MS = 500;     // grace period after a mount, before seeks count
const REMOUNT_DELAY = 200; // let a scrub settle before rebuilding the demuxer

export function createHlsFeeder(video, session, { startAt = 0, onError = null } = {}) {
  const durations = Array.isArray(session.durations) ? session.durations : [];
  const hasMap = Boolean(session.hasMap);
  // A bare container type is not enough for addSourceBuffer — MSE wants the
  // codec list. The server probes it from the PMT and sends candidates in
  // preference order; the first one the browser accepts wins.
  const candidates = (Array.isArray(session.mimes) && session.mimes.length)
    ? session.mimes
    : [session.mime || 'video/mp2t'];
  const mediaTotal = session.segments;
  // With an init segment the client's numbering shifts by one: index 0 is the
  // init and the media segments run 1..n, matching what the server serves.
  const total = mediaTotal + (hasMap ? 1 : 0);

  if (typeof MediaSource === 'undefined' || !candidates.some((type) => MediaSource.isTypeSupported(type))) return null;

  // Cumulative start time per segment; the playlist is the only index HLS has.
  const starts = new Float64Array(mediaTotal + 1);
  for (let i = 0; i < mediaTotal; i += 1) {
    starts[i + 1] = starts[i] + (durations[i] || session.segmentDuration || 4);
  }
  const duration = starts[mediaTotal] || session.duration || 0;

  const indexForTime = (time) => {
    if (time <= 0) return 0;
    let lo = 0;
    let hi = mediaTotal;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (starts[mid + 1] <= time) lo = mid + 1;
      else hi = mid;
    }
    return Math.min(lo, mediaTotal - 1);
  };

  const bufferedEnd = () => {
    const { buffered } = video;
    return buffered && buffered.length ? buffered.end(buffered.length - 1) : 0;
  };

  const covered = (time) => {
    const { buffered } = video;
    for (let i = 0; i < buffered.length; i += 1) {
      if (time >= buffered.start(i) - 0.4 && time <= buffered.end(i) - 0.15) return true;
    }
    return false;
  };

  /**
   * The buffered range a playhead is trying to sit in.
   *
   * `buffered.start(0)` is the oldest range in the buffer, which is the wrong
   * one after a seek: a jump forward leaves the old range first and the new one
   * after it. Picking the nearest range keeps the nudge aimed at the playhead.
   */
  const nearestRange = (time) => {
    const { buffered } = video;
    let best = null;
    for (let i = 0; i < buffered.length; i += 1) {
      const start = buffered.start(i);
      const end = buffered.end(i);
      const distance = time < start ? start - time : time > end ? time - end : 0;
      if (!best || distance < best.distance) best = { start, end, distance };
    }
    return best;
  };

  /**
   * Put the playhead on real media.
   *
   * The element will not play a position that sits even a fraction of a second
   * before the first frame a range holds — it stays in `seeking` with
   * readyState 1 indefinitely. `covered` tolerates that gap when scheduling, so
   * every landing goes through here and gets clamped onto the range start.
   *
   * Forward only: it never drags the playhead back to a range behind it.
   */
  const seekTo = (time) => {
    const near = nearestRange(time);
    const target = near && time < near.start + 0.05 ? near.start + 0.05 : time;
    if (Math.abs(target - video.currentTime) < 0.01) return;
    try { video.currentTime = target; } catch { /* not seekable yet */ }
  };

  const fetchSegment = async (index) => {
    const res = await fetch(`${session.base}/${index}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`segment ${index}: HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  };

  let detachCurrent = null;
  let mountSeq = 0;
  let mountedAt = 0;
  let remountTimer = null;
  let closed = false;

  /**
   * One mount is one MediaSource, and one MediaSource is one demuxer.
   *
   * Chrome's MPEG-TS demuxer keeps a single continuous DTS expectation for the
   * life of a SourceBuffer. Feed it a segment four thousand seconds past what
   * it has already parsed and it rejects the append with
   * `CHUNK_DEMUXER_ERROR_APPEND_FAILED: Parsed buffers not in DTS sequence` —
   * which latches `HTMLMediaElement.error` and kills every later append.
   * `timestampOffset` would fix that, but Chrome refuses to set it while the
   * buffer is mid-parse. So a long seek throws the whole mount away and starts
   * a fresh one at the new position: new demuxer, clean timeline, one segment
   * refetched.
   */
  const mount = (from) => {
    const mediaSource = new MediaSource();
    const objectUrl = URL.createObjectURL(mediaSource);
    video.src = objectUrl;

    const seq = (mountSeq += 1);
    mountedAt = Date.now();

    let sourceBuffer = null;
    let next = 0;              // next segment index to fetch
    let busy = false;
    let stopped = false;
    let retries = 0;
    let landed = false;
    let pendingSeek = Number.isFinite(from) && from > 0 ? from : 0;

    // Playback state for diagnostics — the queue, not the media. Small enough
    // to leave in: a stalled stream is otherwise invisible from the outside.
    video.__hlsState = () => ({
      next,
      busy,
      stopped,
      retries,
      landed,
      mediaTotal,
      hasMap,
      mount: seq,
    });

    const fail = (err) => {
      if (stopped) return;
      stopped = true;
      try { mediaSource.endOfStream('network'); } catch { /* already closed */ }
      onError?.(err instanceof Error ? err : new Error(String(err)));
    };

    const append = (bytes) => new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        sourceBuffer.removeEventListener('updateend', onEnd);
        sourceBuffer.removeEventListener('error', onErr);
      };
      // A SourceBuffer that is aborted mid-append can swallow updateend, which
      // would leave the queue waiting forever on a promise nobody settles.
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('source buffer stalled'));
      }, 20_000);
      const onEnd = () => {
        cleanup();
        resolve();
      };
      const onErr = () => {
        cleanup();
        reject(new Error('source buffer rejected a segment'));
      };
      sourceBuffer.addEventListener('updateend', onEnd);
      sourceBuffer.addEventListener('error', onErr);
      try {
        sourceBuffer.appendBuffer(bytes);
      } catch (err) {
        cleanup();
        reject(err);
      }
    });

    // Segments are a few megabytes each and one connection delivers them slower
    // than real time, so a strictly serial fetch→append loop starves. Keep a
    // short pipeline in flight and append it in order.
    const inflight = new Map();
    const startFetch = (index) => {
      if (inflight.has(index) || index >= total) return;
      const promise = fetchSegment(index);
      // Handled here so a dropped fetch (a seek moved the queue past it) cannot
      // surface as an unhandled rejection; the pump still awaits the original.
      promise.catch(() => { inflight.delete(index); });
      inflight.set(index, promise);
    };
    const fetchAhead = () => {
      const until = Math.min(next + AHEAD, total);
      for (let index = next; index < until; index += 1) startFetch(index);
    };

    const pump = async () => {
      if (stopped || busy || !sourceBuffer) return;

      // Hold the window: enough buffered ahead means wait for the playhead.
      if (video.currentTime > 0 && bufferedEnd() - video.currentTime >= LOOKAHEAD) return;
      if (next >= total) {
        if (mediaSource.readyState === 'open') {
          try { mediaSource.endOfStream(); } catch { /* already ended */ }
        }
        return;
      }

      busy = true;
      try {
        startFetch(next);
        fetchAhead();
        const bytes = await inflight.get(next);
        inflight.delete(next);
        await append(bytes);
        retries = 0;
        next += 1;

        // A transport stream does not start at PTS 0, so a buffered range can
        // begin seconds after the timestamp the playlist promised — 32 s in on
        // some provider encodes. The element sits before the data and refuses
        // to play, so snap it forward to the first frame the buffer holds.
        seekTo(video.currentTime);

        if (!landed && pendingSeek > 0 && covered(pendingSeek)) {
          seekTo(pendingSeek);
          landed = true;
        }
        // A resume point can fall in the gap before the first frame a segment
        // actually holds; sitting on real media at all counts as landing.
        if (!landed && covered(video.currentTime)) landed = true;
        if (!landed && pendingSeek === 0) landed = true;
      } catch (err) {
        if (stopped) return;
        inflight.delete(next);
        retries += 1;
        if (retries > MAX_RETRIES) {
          fail(err);
          return;
        }
      } finally {
        busy = false;
      }

      // Continue on the next tick so the element gets a chance to drain.
      if (!stopped) setTimeout(pump, 0);
    };

    mediaSource.addEventListener('sourceopen', async () => {
      for (const type of candidates) {
        if (!MediaSource.isTypeSupported(type)) continue;
        try {
          sourceBuffer = mediaSource.addSourceBuffer(type);
          break;
        } catch {
          // The browser claimed support and then refused the buffer; try the next.
        }
      }
      if (!sourceBuffer) {
        fail(new Error('no supported source buffer for this stream'));
        return;
      }

      if (duration) {
        try { mediaSource.duration = duration; } catch { /* live playlists refuse */ }
      }

      // The init segment describes the whole track, so it goes in first no matter
      // where playback starts. Only then can a media segment be appended.
      if (hasMap) {
        try {
          await append(await fetchSegment(0));
        } catch (err) {
          fail(err);
          return;
        }
      }

      if (pendingSeek > 0) {
        // Start the fetch at the resume point instead of walking from zero.
        next = hasMap ? indexForTime(pendingSeek) + 1 : indexForTime(pendingSeek);
      } else {
        next = hasMap ? 1 : 0;
      }
      pump();
    });

    mediaSource.addEventListener('error', () => fail(new Error('media source closed')));

    // A seek outside the buffered window cannot be appended into this demuxer,
    // so it gets a fresh mount at the new position. A scrub fires one seek per
    // pixel of travel, so the rebuild waits for the drag to settle.
    const onSeeking = () => {
      if (stopped || closed || !sourceBuffer || !video.seeking) return;
      // A new mount resets the element to zero and fires a seek of its own.
      if (Date.now() - mountedAt < SETTLE_MS) return;
      // A hair before the first frame of a range: the element will never play
      // from there, but the data is right in front of it. Snap on, don't rebuild.
      const near = nearestRange(video.currentTime);
      if (near && video.currentTime < near.start) {
        seekTo(video.currentTime);
        return;
      }
      if (covered(video.currentTime)) return;
      clearTimeout(remountTimer);
      remountTimer = setTimeout(() => { remount(video.currentTime); }, REMOUNT_DELAY);
    };
    video.addEventListener('seeking', onSeeking);

    const onTimeUpdate = () => {
      if (stopped || busy) return;
      if (bufferedEnd() - video.currentTime < LOOKAHEAD / 2) pump();
    };
    video.addEventListener('timeupdate', onTimeUpdate);

    return () => {
      stopped = true;
      video.removeEventListener('seeking', onSeeking);
      video.removeEventListener('timeupdate', onTimeUpdate);
      try { sourceBuffer?.abort(); } catch { /* already gone */ }
      try {
        if (mediaSource.readyState === 'open') mediaSource.endOfStream();
      } catch { /* already ended */ }
      URL.revokeObjectURL(objectUrl);
    };
  };

  const remount = (time) => {
    if (closed) return;
    clearTimeout(remountTimer);
    remountTimer = null;
    const wasPlaying = !video.paused;
    try { detachCurrent?.(); } catch { /* already detached */ }
    detachCurrent = mount(time);
    // A remount is a src change, so the element needs telling to resume.
    if (wasPlaying) video.play().catch(() => { /* autoplay refused */ });
  };

  detachCurrent = mount(startAt);

  /**
   * The handle is the teardown function plus the two things the player needs
   * from a feeder it cannot get off the element: where the timeline ends, and a
   * seek that reaches past the buffered window.
   *
   * `video.currentTime = t` is clamped to `video.seekable`, and for MSE that is
   * the buffered ranges and nothing else. Rewinding past the oldest buffered
   * range therefore did nothing: the element snapped back to the range edge, the
   * feeder saw a covered position, and the playhead never moved. Handing the
   * target here skips the clamp — a covered target is a plain seek, anything
   * else gets a fresh mount at that position.
   */
  const handle = () => {
    closed = true;
    clearTimeout(remountTimer);
    remountTimer = null;
    try { detachCurrent?.(); } catch { /* already detached */ }
    detachCurrent = null;
  };
  handle.duration = duration;
  handle.seek = (time) => {
    if (closed) return;
    const target = Math.max(0, Math.min(duration || Infinity, Number(time) || 0));
    if (covered(target)) {
      seekTo(target);
      return;
    }
    remount(target);
  };

  return handle;
}
