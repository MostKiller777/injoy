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
  const total = session.segments;

  if (typeof MediaSource === 'undefined' || !candidates.some((type) => MediaSource.isTypeSupported(type))) return null;

  // Cumulative start time per segment; the playlist is the only index HLS has.
  const starts = new Float64Array(total + 1);
  for (let i = 0; i < total; i += 1) {
    starts[i + 1] = starts[i] + (durations[i] || session.segmentDuration || 4);
  }
  const duration = starts[total] || session.duration || 0;

  const mediaSource = new MediaSource();
  const objectUrl = URL.createObjectURL(mediaSource);
  video.src = objectUrl;

  let sourceBuffer = null;
  let next = 0;              // next segment index to fetch
  let busy = false;
  let stopped = false;
  let retries = 0;
  let landed = false;
  let pendingSeek = Number.isFinite(startAt) && startAt > 0 ? startAt : 0;

  const indexForTime = (time) => {
    if (time <= 0) return 0;
    let lo = 0;
    let hi = total;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (starts[mid + 1] <= time) lo = mid + 1;
      else hi = mid;
    }
    return Math.min(lo, total - 1);
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

  const fail = (err) => {
    if (stopped) return;
    stopped = true;
    try { mediaSource.endOfStream('network'); } catch { /* already closed */ }
    onError?.(err instanceof Error ? err : new Error(String(err)));
  };

  const append = (bytes) => new Promise((resolve, reject) => {
    const onEnd = () => {
      sourceBuffer.removeEventListener('updateend', onEnd);
      sourceBuffer.removeEventListener('error', onErr);
      resolve();
    };
    const onErr = () => {
      sourceBuffer.removeEventListener('updateend', onEnd);
      sourceBuffer.removeEventListener('error', onErr);
      reject(new Error('source buffer rejected a segment'));
    };
    sourceBuffer.addEventListener('updateend', onEnd);
    sourceBuffer.addEventListener('error', onErr);
    try {
      sourceBuffer.appendBuffer(bytes);
    } catch (err) {
      sourceBuffer.removeEventListener('updateend', onEnd);
      sourceBuffer.removeEventListener('error', onErr);
      reject(err);
    }
  });

  const fetchSegment = async (index) => {
    const res = await fetch(`${session.base}/${index}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`segment ${index}: HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
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
      if (hasMap && next === 0) {
        await append(await fetchSegment(0));
        next = 1;
      }
      const bytes = await fetchSegment(next);
      await append(bytes);
      retries = 0;
      next += 1;

      // A transport stream does not start at PTS 0, so the buffered range can
      // begin at, say, 1.4 s. The element sits at 0 and refuses to play with no
      // data at the playhead; nudge it to the first byte the buffer holds.
      const start = video.buffered.length ? video.buffered.start(0) : 0;
      if (video.currentTime < start - 0.05 && pendingSeek <= 0) {
        try { video.currentTime = start + 0.05; } catch { /* not seekable yet */ }
      }

      if (!landed && pendingSeek > 0 && covered(pendingSeek)) {
        video.currentTime = pendingSeek;
        landed = true;
      }
      if (!landed && pendingSeek === 0) landed = true;
    } catch (err) {
      if (stopped) return;
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

  mediaSource.addEventListener('sourceopen', () => {
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
    if (pendingSeek > 0) {
      // Start the fetch at the resume point instead of walking from zero.
      next = indexForTime(pendingSeek);
      if (hasMap) next += 1;
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
    if (hasMap && index === 0) return;
    const target = hasMap ? index + 1 : index;
    if (target >= next && target < next + 2) return; // already heading there
    next = target;
    try { sourceBuffer.abort(); } catch { /* nothing buffered */ }
    busy = false;
    setTimeout(pump, 0);
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
