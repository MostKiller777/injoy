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

  const mediaSource = new MediaSource();
  const objectUrl = URL.createObjectURL(mediaSource);
  video.src = objectUrl;

  let sourceBuffer = null;
  let next = 0;              // next segment index to fetch
  let restartAt = null;      // seek target waiting for the in-flight append
  let busy = false;
  let stopped = false;
  let retries = 0;
  let landed = false;
  let pendingSeek = Number.isFinite(startAt) && startAt > 0 ? startAt : 0;

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

  // Playback state for diagnostics — the queue, not the media. Small enough to
  // leave in: a stalled stream is otherwise invisible from the outside.
  video.__hlsState = () => ({ next, busy, restartAt, stopped, retries, landed, mediaTotal, hasMap });

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

  const fetchSegment = async (index) => {
    const res = await fetch(`${session.base}/${index}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`segment ${index}: HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  };

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
      // A seek asked for a new start point while the previous append was in
      // flight; honour it now that the buffer is idle.
      if (restartAt !== null) {
        next = restartAt;
        restartAt = null;
        // Drop fetches for positions the seek jumped over.
        for (const key of [...inflight.keys()]) if (key < next) inflight.delete(key);
      }
      startFetch(next);
      fetchAhead();
      const bytes = await inflight.get(next);
      inflight.delete(next);
      await append(bytes);
      retries = 0;
      next += 1;

      // A transport stream does not start at PTS 0, so a buffered range can
      // begin a second or so after the timestamp the playlist promised. The
      // element sits just before the data and refuses to play, so snap it to
      // the first frame the buffer actually holds — using the range nearest the
      // playhead, not the oldest one, which is what a forward seek leaves behind.
      const near = nearestRange(video.currentTime);
      if (near && near.start - video.currentTime > 0.05 && near.start - video.currentTime < 5) {
        try { video.currentTime = near.start + 0.05; } catch { /* not seekable yet */ }
      }

      if (!landed && pendingSeek > 0 && covered(pendingSeek)) {
        video.currentTime = pendingSeek;
        landed = true;
      }
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

  // A seek outside the buffered window restarts the queue at the new position.
  const onSeeking = () => {
    if (stopped || !sourceBuffer || !video.seeking) return;
    const time = video.currentTime;
    if (covered(time)) return;
    const index = indexForTime(time);
    const target = hasMap ? index + 1 : index;
    if (target >= next && target < next + 2) return; // already heading there
    // Never abort a pending append: an interrupted append can leave the queue
    // waiting on an updateend that never arrives. The next pump jumps forward.
    restartAt = target;
    if (!busy) {
      next = restartAt;
      restartAt = null;
      setTimeout(pump, 0);
    }
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
}
