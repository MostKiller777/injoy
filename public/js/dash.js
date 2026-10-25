/**
 * DASH playback through Media Source Extensions.
 *
 * The direct-stream providers answer with a static DASH manifest: one HEVC video
 * track, one AAC audio track, five-second fMP4 segments. A browser does not need
 * a muxer for that — MSE takes a SourceBuffer per track and keeps them in sync
 * off their own decode timestamps.
 *
 * The feeder keeps a bounded look-ahead window (eight segments), refills on
 * `timeupdate`, and rebuilds the whole pipeline when a seek lands outside the
 * buffered range. Rebuilding means a fresh MediaSource: clearing two buffers by
 * hand is fiddly, and one new object URL is always consistent.
 */

const AHEAD_SEGMENTS = 8;
const LOW_WATER_SEGMENTS = 3;

export function createDashFeeder(video, session, { startAt = 0, onError } = {}) {
  const segDuration = session.segmentDuration || 5;
  const segmentCount = session.segments ?? 0;
  const totalDuration = session.duration ?? 0;
  const sid = session.sid;

  let mediaSource = null;
  let objectUrl = null;
  let videoBuffer = null;
  let audioBuffer = null;
  let next = 1;
  let pumping = false;
  let rebuilding = false;
  let destroyed = false;

  // A live session proxies the provider; a downloaded one serves its own disk.
  // Same segment indices either way — only the base path changes.
  const base = session.base ?? `/api/dash/seg/${sid}`;
  const segmentPath = (track, index) => `${base}/${track}/${index}`;

  async function fetchSegment(track, index) {
    const res = await fetch(segmentPath(track, index), { cache: 'default' });
    if (!res.ok) throw new Error(`${track} segment ${index}: HTTP ${res.status}`);
    return res.arrayBuffer();
  }

  function append(buffer, data) {
    return new Promise((resolve, reject) => {
      if (!buffer || destroyed) {
        resolve();
        return;
      }
      const done = () => {
        buffer.removeEventListener('error', fail);
        resolve();
      };
      const fail = () => {
        buffer.removeEventListener('updateend', done);
        reject(new Error('append rejected'));
      };
      buffer.addEventListener('updateend', done, { once: true });
      buffer.addEventListener('error', fail, { once: true });
      try {
        buffer.appendBuffer(data);
      } catch (err) {
        buffer.removeEventListener('updateend', done);
        buffer.removeEventListener('error', fail);
        reject(err);
      }
    });
  }

  async function appendSegment(index) {
    const [videoData, audioData] = await Promise.all([
      fetchSegment('video', index),
      fetchSegment('audio', index),
    ]);
    if (destroyed) return;
    await append(videoBuffer, videoData);
    await append(audioBuffer, audioData);
  }

  function bufferedEnd() {
    if (!video.buffered.length) return 0;
    return video.buffered.end(video.buffered.length - 1);
  }

  const ahead = () => Math.max(0, bufferedEnd() - video.currentTime);

  function isBuffered(time) {
    for (let i = 0; i < video.buffered.length; i += 1) {
      if (time >= video.buffered.start(i) && time <= video.buffered.end(i) - 0.05) return true;
    }
    return false;
  }

  async function pump() {
    if (pumping || rebuilding || destroyed) return;
    pumping = true;
    try {
      while (!destroyed && next <= segmentCount && ahead() < AHEAD_SEGMENTS * segDuration) {
        await appendSegment(next);
        next += 1;
      }
    } catch (err) {
      if (!destroyed) onError?.(err);
    } finally {
      pumping = false;
    }
  }

  async function attach() {
    mediaSource = new MediaSource();
    const previous = objectUrl;
    objectUrl = URL.createObjectURL(mediaSource);
    video.src = objectUrl;
    if (previous) URL.revokeObjectURL(previous);

    await new Promise((resolve) => mediaSource.addEventListener('sourceopen', resolve, { once: true }));
    if (destroyed) return;

    videoBuffer = mediaSource.addSourceBuffer(session.video.mime);
    audioBuffer = mediaSource.addSourceBuffer(session.audio.mime);

    await append(videoBuffer, await fetchSegment('video', 0));
    await append(audioBuffer, await fetchSegment('audio', 0));
    if (totalDuration) {
      try {
        mediaSource.duration = totalDuration;
      } catch {
        // duration is already fixed by the init segment
      }
    }
  }

  async function start(time) {
    next = Math.max(1, Math.floor(time / segDuration) + 1);
    await attach();
    if (destroyed) return;
    await appendSegment(next);
    next += 1;
    if (time > 0.4) video.currentTime = time;
    pump();
  }

  async function rebuild(time) {
    if (rebuilding || destroyed) return;
    rebuilding = true;
    try {
      const wasPlaying = !video.paused;
      await start(time);
      if (wasPlaying) video.play().catch(() => {});
    } catch (err) {
      if (!destroyed) onError?.(err);
    } finally {
      rebuilding = false;
    }
  }

  function onTimeUpdate() {
    if (destroyed || rebuilding) return;
    if (ahead() < LOW_WATER_SEGMENTS * segDuration) pump();
  }

  function onSeeking() {
    if (destroyed || rebuilding) return;
    if (!videoBuffer) return;
    if (!isBuffered(video.currentTime)) rebuild(video.currentTime);
  }

  video.addEventListener('timeupdate', onTimeUpdate);
  video.addEventListener('seeking', onSeeking);

  start(Math.max(0, startAt)).catch((err) => {
    if (!destroyed) onError?.(err);
  });

  return {
    kind: 'dash',
    duration: totalDuration,
    destroy() {
      destroyed = true;
      video.removeEventListener('timeupdate', onTimeUpdate);
      video.removeEventListener('seeking', onSeeking);
      try {
        if (mediaSource && mediaSource.readyState === 'open') mediaSource.endOfStream();
      } catch {
        // the source was already torn down by the element
      }
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    },
  };
}
