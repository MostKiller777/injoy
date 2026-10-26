import { createDecipheriv } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { dashSegmentUrl, loadDashManifest, resolveDashTracks } from './dash.js';
import { dashSegmentFile, prepareDashDir, removeDash, writeDashManifest } from './dashstore.js';
import {
  firstMissingHlsSegment,
  hlsBytes,
  hlsInitFile,
  hlsSegmentFile,
  prepareHlsDir,
  writeHlsManifest,
} from './hlsstore.js';
import { registerDash, registerHls, registerMedia, mediaPath, safeKey } from './media.js';
import { isPlaying } from './playback.js';
import { resolveStream } from './resolver.js';
import { FMP4_MIMES, probeTsCodecs, tsMimes } from './tscodec.js';
import { probeTsStartPts } from './tsprobe.js';

/**
 * Download engine.
 *
 * Two shapes arrive from the embed resolvers: a progressive file, or an HLS
 * playlist. A progressive file lands as one file on disk, because one file is
 * what a <video> tag and a byte-range request can seek through. An HLS playlist
 * lands as a directory of segments instead — the player already consumes HLS
 * segment by segment, and one file per segment is what makes a fetch resumable.
 *
 * HLS handling that matters in practice:
 * - master playlists: pick the highest-bandwidth variant
 * - `#EXT-X-MAP`: save the init segment, which is what makes fMP4 playable
 * - `#EXT-X-KEY` AES-128: decrypt per segment, explicit IV or sequence number
 * - `#EXT-X-BYTERANGE`: sub-range requests against a single hosting file
 * - an expired signed URL: resolve the playlist again and continue at the first
 *   segment that is not on disk, so an hour of video is never refetched
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36';
const CONCURRENCY = 6;
const REQUEST_TIMEOUT = 30_000;
const MAX_SEGMENTS = 20_000;
// A single stalled connection should cost one segment, not the whole job: a
// feature-length fetch is hundreds of requests and one of them will hang.
const SEGMENT_ATTEMPTS = 4;
// DASH downloads ride signed URLs that expire long before a feature-length
// fetch finishes, so the job refreshes the manifest instead of dying.
const DASH_CONCURRENCY = 6;
const MAX_URL_REFRESH = 8;

export const jobs = new Map();

const now = () => Date.now();

function jobView(job) {
  const elapsed = Math.max(1, now() - job.startedAt) / 1000;
  // A single-file fetch knows its size up front; a segmented one only knows how
  // many segments it has to get, so that is the percentage it reports.
  const percent = job.total > 0
    ? Math.min(100, Math.round((job.bytes / job.total) * 100))
    : job.segmentsTotal > 0
      ? Math.min(100, Math.round((job.segmentsDone / job.segmentsTotal) * 100))
      : null;
  return {
    id: job.id,
    title: job.title,
    status: job.status,
    bytes: job.bytes,
    total: job.total,
    percent,
    segmentsDone: job.segmentsDone,
    segmentsTotal: job.segmentsTotal,
    refreshes: job.refreshes ?? 0,
    speed: Math.round(job.bytes / elapsed),
    error: job.error ?? null,
    container: job.container ?? null,
    playable: job.playable ?? null,
    startedAt: job.startedAt,
    updatedAt: job.updatedAt ?? job.startedAt,
  };
}

export function jobFor(id) {
  const job = jobs.get(String(id));
  return job ? jobView(job) : null;
}

export function allJobs() {
  return [...jobs.values()].map(jobView).sort((a, b) => b.startedAt - a.startedAt);
}

export function cancelDownload(id) {
  const job = jobs.get(String(id));
  if (!job) return false;
  if (job.status === 'done' || job.status === 'error' || job.status === 'cancelled') return false;
  job.cancelled = true;
  job.controller.abort(new Error('cancelled'));
  job.status = 'cancelled';
  job.updatedAt = now();
  return true;
}

async function request(url, { headers = {}, signal, asText = false } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), REQUEST_TIMEOUT);
  const onAbort = () => controller.abort(new Error('cancelled'));
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': UA, ...headers },
      redirect: 'follow',
      signal: controller.signal,
    });
    if (!res.ok) {
      const err = new Error(`${res.status} ${res.statusText} ${url.slice(0, 120)}`);
      err.status = res.status;
      throw err;
    }
    if (asText) return await res.text();
    const buffer = Buffer.from(await res.arrayBuffer());
    return { buffer, contentType: res.headers.get('content-type') ?? '' };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

function parseAttributes(line) {
  const attrs = {};
  for (const match of line.matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g)) {
    attrs[match[1]] = match[2].replace(/^"|"$/g, '');
  }
  return attrs;
}

function absolute(base, ref) {
  try {
    return new URL(ref, base).toString();
  } catch {
    return ref;
  }
}

/** Walk down a master playlist until a media playlist is reached. */
async function resolveMediaPlaylist(url, headers, signal, depth = 0) {
  if (depth > 4) throw new Error('playlist nesting too deep');
  const text = await request(url, { headers, signal, asText: true });
  if (!text.includes('#EXTM3U')) throw new Error('not an HLS playlist');

  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const variants = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].startsWith('#EXT-X-STREAM-INF')) continue;
    const attrs = parseAttributes(lines[i]);
    const uri = lines.slice(i + 1).find((line) => !line.startsWith('#'));
    if (!uri) continue;
    variants.push({
      url: absolute(url, uri),
      bandwidth: Number(attrs.BANDWIDTH ?? 0),
      resolution: attrs.RESOLUTION ?? '',
    });
  }

  if (variants.length) {
    variants.sort((a, b) => b.bandwidth - a.bandwidth);
    return resolveMediaPlaylist(variants[0].url, headers, signal, depth + 1);
  }

  return { url, text };
}

/** Turn a media playlist into an ordered list of byte sources. */
function parseSegments(url, text) {
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  const base = url;

  const segments = [];
  const durations = [];
  let total = 0;
  let pendingDuration = 0;
  let map = null;
  let key = null;
  let pendingRange = null;
  let sequence = 0;

  for (const line of lines) {
    if (!line) continue;

    if (line.startsWith('#EXT-X-MAP:')) {
      const attrs = parseAttributes(line.slice(line.indexOf(':') + 1));
      if (attrs.URI) map = { url: absolute(base, attrs.URI), range: attrs.BYTERANGE ?? null };
      continue;
    }

    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      sequence = Number(line.split(':')[1]) || 0;
      continue;
    }

    if (line.startsWith('#EXT-X-KEY:')) {
      const attrs = parseAttributes(line.slice(line.indexOf(':') + 1));
      if (!attrs.METHOD || attrs.METHOD === 'NONE') {
        key = null;
      } else if (attrs.METHOD === 'AES-128') {
        key = { url: absolute(base, attrs.URI), iv: attrs.IV ?? null, index: sequence + segments.length };
      } else {
        throw new Error(`unsupported HLS encryption: ${attrs.METHOD}`);
      }
      continue;
    }

    if (line.startsWith('#EXTINF:')) {
      pendingDuration = Number.parseFloat(line.slice(line.indexOf(':') + 1)) || 0;
      continue;
    }

    if (line.startsWith('#EXT-X-BYTERANGE:')) {
      pendingRange = line.slice(line.indexOf(':') + 1);
      continue;
    }

    if (line.startsWith('#')) continue;

    segments.push({
      url: absolute(base, line),
      range: pendingRange,
      key,
      index: segments.length,
    });
    // The playlist's EXTINF values are the only per-segment timing that exists;
    // the player needs them to map a seek position back to a segment index.
    durations.push(pendingDuration);
    total += pendingDuration;
    pendingDuration = 0;
    pendingRange = null;
  }

  return { segments: segments.slice(0, MAX_SEGMENTS), durations, total, map };
}

function rangeHeader(range, cursor) {
  if (!range) return { header: null, next: null };
  const [lengthRaw, offsetRaw] = String(range).split('@');
  const length = Number(lengthRaw);
  const offset = offsetRaw === undefined ? cursor : Number(offsetRaw);
  if (!Number.isFinite(length) || length <= 0) return { header: null, next: null };
  return {
    header: `bytes=${offset}-${offset + length - 1}`,
    next: offset + length,
  };
}

function ivFor(key, index) {
  if (key.iv) {
    const clean = key.iv.replace(/^0x/i, '');
    return Buffer.from(clean.padStart(32, '0'), 'hex');
  }
  const iv = Buffer.alloc(16);
  iv.writeUInt32BE(index >>> 0, 12);
  return iv;
}

function decrypt(buffer, keyBytes, iv) {
  const decipher = createDecipheriv('aes-128-cbc', keyBytes, iv);
  return Buffer.concat([decipher.update(buffer), decipher.final()]);
}

async function fetchSegment(segment, headers, signal, keyCache, rangeCursor) {
  const { header } = rangeHeader(segment.range, rangeCursor ?? 0);
  const requestHeaders = { ...headers };
  if (header) requestHeaders.range = header;
  const { buffer } = await request(segment.url, { headers: requestHeaders, signal });

  if (!segment.key) return buffer;
  let keyBytes = keyCache.get(segment.key.url);
  if (!keyBytes) {
    const keyRes = await request(segment.key.url, { headers, signal });
    keyBytes = keyRes.buffer;
    if (keyBytes.length !== 16) throw new Error('AES key is not 16 bytes');
    keyCache.set(segment.key.url, keyBytes);
  }
  return decrypt(buffer, keyBytes, ivFor(segment.key, segment.index));
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** A status worth retrying: the CDN is busy, not the request is wrong. */
const TRANSIENT_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * One segment, with a few attempts.
 *
 * A 404 is a dead link and a 403 is an expired signature — both are the caller's
 * problem to solve by re-resolving, so they are returned immediately. A timeout,
 * a reset socket or a 503 is weather, and weather gets retried with backoff.
 */
async function fetchSegmentWithRetry(segment, headers, signal, keyCache) {
  let lastError = null;
  for (let attempt = 0; attempt < SEGMENT_ATTEMPTS; attempt += 1) {
    try {
      return await fetchSegment(segment, headers, signal, keyCache, 0);
    } catch (err) {
      lastError = err;
      if (signal?.aborted) throw err;
      const transient = !err.status || TRANSIENT_STATUS.has(err.status);
      if (!transient) throw err;
      await sleep(Math.min(6000, 400 * 2 ** attempt));
    }
  }
  throw lastError;
}

/** Decide the saved container from what the playlist actually contains. */
function containerFor(map, firstSegment) {
  if (map) return { kind: 'hls', ext: '.m4s', playable: true };
  const name = (firstSegment?.url ?? '').toLowerCase();
  if (name.includes('.mp4') || name.includes('.m4s')) return { kind: 'hls', ext: '.m4s', playable: true };
  return { kind: 'hls', ext: '.ts', playable: true };
}

async function downloadProgressive(job, url, headers) {
  const res = await fetch(url, {
    headers: { 'user-agent': UA, ...headers },
    redirect: 'follow',
    signal: job.controller.signal,
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);

  const total = Number(res.headers.get('content-length') ?? 0) || null;
  const type = res.headers.get('content-type') ?? '';

  // A DASH manifest arrives looking like a file. Saving it would produce a
  // 30 KB "movie" that no player can open, so reject it here by content type
  // and by the manifest's own first bytes.
  if (/dash\+xml/i.test(type)) throw new Error('source is a DASH manifest (video and audio are separate tracks)');

  const ext = type.includes('webm') ? '.webm' : '.mp4';

  job.total = total;
  job.segmentsTotal = 1;
  await mkdir(dirname(job.tempPath), { recursive: true });
  const handle = await open(job.tempPath, 'w');

  try {
    let head = Buffer.alloc(0);
    for await (const chunk of res.body) {
      if (job.cancelled) throw new Error('cancelled');
      if (head.length < 512) {
        head = Buffer.concat([head, chunk.subarray(0, 512 - head.length)]);
        const sniff = head.toString('utf8').trimStart();
        if (sniff.startsWith('<?xml') || sniff.startsWith('<MPD')) {
          throw new Error('source is a DASH manifest (video and audio are separate tracks)');
        }
      }
      await handle.write(chunk);
      job.bytes += chunk.length;
      job.updatedAt = now();
    }
  } finally {
    await handle.close();
  }

  job.segmentsDone = 1;
  job.container = { ext, playable: true };
  return { ext, playable: true };
}

/**
 * Save an HLS playlist as one file per segment.
 *
 * Per-segment files are what make the job resumable: a segment already on disk
 * is skipped, so an expiry, a stalled connection, or a server restart continues
 * at the first hole instead of refetching an hour of video. The saved copy is
 * then played through the very same feeder the live proxy feeds.
 */
async function downloadHls(job, url, headers) {
  await prepareHlsDir(job.id);
  const keyCache = new Map();

  let currentUrl = url;
  let currentHeaders = headers;
  let refreshes = 0;
  let manifest = null;
  let written = 0;

  for (;;) {
    const media = await resolveMediaPlaylist(currentUrl, currentHeaders, job.controller.signal);
    const { segments, durations, total, map } = parseSegments(media.url, media.text);
    if (!segments.length) throw new Error('playlist has no segments');

    const container = containerFor(map, segments[0]);
    const ext = container.ext;

    // A different segment count after a refresh means the provider switched
    // rendition; the files on disk belong to another encode.
    if (manifest && manifest.segments !== segments.length) throw new Error('stream changed while downloading');

    job.segmentsTotal = segments.length;
    job.container = container;

    if (!manifest) {
      manifest = {
        id: job.id,
        title: job.title,
        container: map ? 'hls-fmp4' : 'hls',
        ext,
        quality: 'auto',
        segments: segments.length,
        durations,
        duration: Math.round(total * 1000) / 1000,
        segmentDuration: durations.length ? Math.round((total / durations.length) * 1000) / 1000 : 4,
      };

      // Written now, not just at the end: a job that is interrupted still has a
      // manifest describing what the files on disk are, and the segment route
      // can serve them.
      await writeHlsManifest(job.id, manifest);

      if (map) {
        const { header } = rangeHeader(map.range, 0);
        const { buffer } = await request(map.url, {
          headers: header ? { ...currentHeaders, range: header } : currentHeaders,
          signal: job.controller.signal,
        });
        await writeFile(hlsInitFile(job.id), buffer);
        job.bytes += buffer.length;
      }

      // A previous attempt may have saved the first half; start at the hole.
      written = await firstMissingHlsSegment(job.id, ext, segments.length);
      job.segmentsDone = written;
      job.bytes = await hlsBytes(job.id);
      job.updatedAt = now();
    }

    // Sliding window: keep CONCURRENCY fetches in flight, write strictly in
    // playlist order so no segment is ever missing from the middle.
    const pending = new Map();
    let nextToStart = written;
    let nextToWrite = written;
    let failure = null;

    const startOne = (index) => {
      const promise = fetchSegmentWithRetry(segments[index], currentHeaders, job.controller.signal, keyCache)
        .then((buffer) => ({ index, buffer }))
        .catch((err) => ({ index, error: err }));
      pending.set(index, promise);
    };

    while (nextToWrite < segments.length) {
      if (job.cancelled) throw new Error('cancelled');
      if (failure) break;

      // Someone watching this title gets the connection; the cache trickles.
      const watching = isPlaying(job.id);
      while (pending.size < (watching ? 1 : CONCURRENCY) && nextToStart < segments.length) {
        startOne(nextToStart);
        nextToStart += 1;
      }

      const settled = await pending.get(nextToWrite);
      pending.delete(nextToWrite);
      if (settled.error) {
        failure = settled.error;
        break;
      }

      await writeFile(hlsSegmentFile(job.id, nextToWrite, ext), settled.buffer);
      job.bytes += settled.buffer.length;
      written = nextToWrite + 1;
      job.segmentsDone = written;
      job.updatedAt = now();
      nextToWrite += 1;
      if (watching) await sleep(1200);
    }

    if (!failure) break;

    const expired = [401, 403, 404, 410].includes(failure.status);
    if (!expired || !job.target || refreshes >= MAX_URL_REFRESH) throw failure;

    refreshes += 1;
    job.refreshes = refreshes;
    const fresh = await resolveStream(job.target);
    if (!fresh.url || !/\.m3u8(\?|$)/i.test(fresh.url)) throw failure;
    currentUrl = fresh.url;
    currentHeaders = fresh.referer
      ? { referer: fresh.referer, origin: new URL(fresh.referer).origin }
      : {};
  }

  // The codec list lives in the media, not the playlist: read it off the first
  // saved segment so a local copy advertises exactly what it contains. The same
  // head gives the first PTS, which the client needs to rebase the timeline.
  let mimes = FMP4_MIMES;
  let startPts = 0;
  if (manifest.container === 'hls') {
    const head = await readFile(hlsSegmentFile(job.id, 0, manifest.ext)).catch(() => null);
    mimes = tsMimes(head ? probeTsCodecs(head) : null);
    startPts = head ? probeTsStartPts(head) ?? 0 : 0;
  }
  manifest.mime = mimes[0];
  manifest.mimes = mimes;
  manifest.startPts = startPts;
  manifest.bytes = await hlsBytes(job.id);
  manifest.savedAt = now();
  await writeHlsManifest(job.id, manifest);

  return { kind: 'hls', ext: manifest.ext, playable: true };
}

/**
 * DASH download: keep the provider's own fragments.
 *
 * Video and audio arrive as separate tracks, so the saved copy is two folders
 * of fMP4 segments plus a manifest. The player feeds those straight into MSE —
 * the same feeder it uses for a live session, pointed at this disk.
 */
async function downloadDash(job, found) {
  let video = found.video;
  let audio = found.audio;
  const { duration } = found;
  let segments = video.segments;
  if (!segments) throw new Error('manifest has no segments');

  const headers = found.referer ? { referer: found.referer, origin: found.referer } : {};

  job.status = 'downloading';
  job.segmentsTotal = segments * 2 + 2;
  job.total = Math.round(((duration || 0) * ((video.bandwidth || 0) + (audio.bandwidth || 0))) / 8) || 0;
  job.container = { ext: 'dash', playable: true };
  job.updatedAt = now();

  await prepareDashDir(job.id);

  // Provider URLs are signed and the signature outlives nothing: a feature
  // length download runs longer than the token does. Re-resolve on expiry and
  // keep the fragments already on disk — the job resumes instead of restarting.
  let refreshes = 0;
  let refreshPending = null;
  let generation = 0;
  let cursor = 0;

  const refresh = async () => {
    if (refreshPending) return refreshPending;
    if (!job.target) throw new Error('stream URL expired and this title cannot be re-resolved');
    if (refreshes >= MAX_URL_REFRESH) throw new Error('stream URL kept expiring; gave up');
    refreshes += 1;
    job.refreshes = refreshes;

    refreshPending = (async () => {
      const next = await resolveDashTracks(job.target);
      if (!next.ok) throw new Error(next.error ?? 're-resolve failed');
      if (!next.video?.segments) throw new Error('re-resolved manifest has no segments');

      // A different rendition means the fragments on disk no longer line up
      // with the URLs, so the partial copy is thrown away and refetched.
      const sameRendition = next.video.segments === segments
        && (next.video.width ?? 0) === (video.width ?? 0)
        && (next.video.height ?? 0) === (video.height ?? 0);

      if (!sameRendition) {
        await removeDash(job.id);
        await prepareDashDir(job.id);
        generation += 1;
        segments = next.video.segments;
        job.segmentsTotal = segments * 2 + 2;
        job.segmentsDone = 0;
        job.bytes = 0;
        cursor = 0;
      }

      video = next.video;
      audio = next.audio;
      job.updatedAt = now();
    })().finally(() => { refreshPending = null; });

    return refreshPending;
  };

  const save = async (name, index) => {
    const file = dashSegmentFile(job.id, name, index);
    const gen = generation;

    // Resume: a fragment already written by an interrupted run is not refetched.
    const onDisk = await stat(file).catch(() => null);
    if (onDisk?.isFile() && onDisk.size > 0) return;

    for (let attempt = 0; ; attempt += 1) {
      const track = name === 'video' ? video : audio;
      try {
        const { buffer } = await request(dashSegmentUrl(track, index), {
          headers,
          signal: job.controller.signal,
        });
        // A refresh may have wiped the track directory mid-flight; a stale
        // buffer belongs to the discarded rendition and must not be written.
        if (gen !== generation) throw Object.assign(new Error('rendition changed'), { stale: true });
        await writeFile(file, buffer);
        job.bytes += buffer.length;
        job.segmentsDone += 1;
        job.updatedAt = now();
        return;
      } catch (err) {
        if (job.cancelled) throw err;
        if (err.stale) { attempt -= 1; continue; }
        const expired = err.status === 401 || err.status === 403 || err.status === 404 || err.status === 410;
        if (!expired || attempt >= 2) throw err;
        await refresh();
      }
    }
  };

  const worker = async () => {
    while (!job.cancelled) {
      const index = cursor;
      cursor += 1;
      if (index > segments) return;
      await Promise.all([save('video', index), save('audio', index)]);
      // Playback of this title owns the connection while it lasts.
      if (isPlaying(job.id)) await sleep(1500);
    }
  };
  await Promise.all(Array.from({ length: DASH_CONCURRENCY }, worker));
  if (job.cancelled) throw new Error('cancelled');

  const manifest = {
    id: job.id,
    title: job.title,
    duration: duration ?? null,
    segmentDuration: video.segmentDuration,
    startNumber: video.startNumber,
    segments,
    video: {
      codecs: video.codecs,
      mime: `video/mp4; codecs="${video.codecs}"`,
      width: video.width ?? 0,
      height: video.height ?? 0,
    },
    audio: { codecs: audio.codecs, mime: `audio/mp4; codecs="${audio.codecs}"` },
    createdAt: now(),
  };
  await writeDashManifest(job.id, manifest);
  await registerDash({ id: job.id, title: job.title, duration: duration ?? null, segments });

  return { ext: 'dash', playable: true };
}

/**
 * No URL given: find one, then take whichever shape it came in. DASH goes to the
 * segment store; HLS and progressive files go through the byte engines.
 */
async function downloadAuto(job, target) {
  job.status = 'resolving';
  job.target = target ?? null;
  job.updatedAt = now();

  const resolved = await resolveStream(target);
  if (job.cancelled) throw new Error('cancelled');
  if (!resolved.url) throw new Error(resolved.error ?? 'no provider produced a stream');

  if (resolved.type === 'dash') {
    const manifest = await loadDashManifest(resolved.url, resolved.referer ?? null);
    if (!manifest.ok) throw new Error(manifest.error);
    return downloadDash(job, { ...manifest, referer: resolved.referer ?? null });
  }

  const headers = resolved.referer
    ? { referer: resolved.referer, origin: new URL(resolved.referer).origin }
    : {};

  job.status = 'downloading';
  job.updatedAt = now();

  let container;
  if (/\.m3u8(\?|$)/i.test(resolved.url)) {
    container = await downloadHls(job, resolved.url, headers);
  } else {
    try {
      container = await downloadProgressive(job, resolved.url, headers);
    } catch (err) {
      if (/DASH manifest/.test(err.message)) throw err;
      container = await downloadHls(job, resolved.url, headers);
    }
  }

  if (job.cancelled) throw new Error('cancelled');

  job.status = 'finalizing';
  job.updatedAt = now();
  // An HLS download already wrote its files and its manifest; a progressive
  // file is still sitting in the temp path and has to be moved into place.
  if (container.kind === 'hls') {
    await registerHls({ id: job.id, title: job.title, source: resolved.url });
  } else {
    const finalPath = mediaPath(job.id, container.ext);
    await rename(job.tempPath, finalPath);
    await registerMedia({
      id: job.id,
      title: job.title,
      file: finalPath,
      ext: container.ext,
      source: resolved.url,
    });
  }

  return container;
}

export function startDashDownload({ id, title, found, target = null }) {
  const key = String(id);
  if (!key) throw new Error('id required');
  if (!found?.video || !found?.audio) throw new Error('dash tracks required');

  const existing = jobs.get(key);
  if (existing && ['resolving', 'downloading', 'finalizing'].includes(existing.status)) {
    return jobView(existing);
  }

  const job = createJob(key, title, null);
  job.container = { ext: 'dash', playable: true };
  job.target = target ?? found.target ?? null;

  (async () => {
    try {
      const container = await downloadDash(job, found);
      job.playable = container.playable;
      job.container = container;
      job.status = 'done';
      job.updatedAt = now();
    } catch (err) {
      job.status = job.cancelled ? 'cancelled' : 'error';
      job.error = err.message;
      job.updatedAt = now();
      // A cancelled job leaves nothing worth keeping. A failed one keeps its
      // fragments: the next attempt resumes from them instead of refetching.
      if (job.cancelled) await removeDash(job.id);
    }
  })();

  return jobView(job);
}

function createJob(id, title, url) {
  const key = String(id);
  const job = {
    id: key,
    title: title ?? key,
    url: url ?? null,
    status: url ? 'downloading' : 'resolving',
    bytes: 0,
    total: 0,
    segmentsDone: 0,
    segmentsTotal: 0,
    startedAt: now(),
    updatedAt: now(),
    controller: new AbortController(),
    tempPath: join(dirname(mediaPath(key)), `${safeKey(key)}.part`),
    cancelled: false,
  };
  jobs.set(key, job);
  return job;
}

/**
 * Kick off a download. Returns the job view immediately; the work continues in
 * the background and is polled through `jobFor`.
 *
 * With no `url` the job is only registered as `resolving` — the route uses that
 * to claim the id while a headless browser looks for a stream, so the client
 * polls one id from the first second instead of racing a second request.
 */
export function startDownload({ id, title, url, referer, origin, target = null }) {
  const key = String(id);
  if (!key) throw new Error('id required');

  const existing = jobs.get(key);
  const active = existing && !['error', 'cancelled', 'done', 'resolving'].includes(existing.status);
  if (active) return jobView(existing);

  const job = createJob(key, title, url);
  job.target = target ?? null;

  if (!url) {
    if (!target) return jobView(job);

    (async () => {
      try {
        const container = await downloadAuto(job, target);
        job.playable = container.playable;
        job.container = container;
        job.status = 'done';
        job.updatedAt = now();
      } catch (err) {
        job.status = job.cancelled ? 'cancelled' : 'error';
        job.error = err.message;
        job.updatedAt = now();
        await rm(job.tempPath, { force: true }).catch(() => {});
        await removeDash(job.id);
      }
    })();

    return jobView(job);
  }

  const headers = referer ? { referer, origin: origin ?? new URL(referer).origin } : {};

  (async () => {
    try {
      const looksHls = /\.m3u8(\?|$)/i.test(url);
      let container;
      if (looksHls) {
        container = await downloadHls(job, url, headers);
      } else {
        // A playlist may hide behind a pretty URL, so fall back on sniffing.
        try {
          container = await downloadProgressive(job, url, headers);
        } catch (err) {
          if (job.cancelled) throw err;
          // A DASH manifest is a dead end, not a mislabelled playlist.
          if (/DASH manifest/.test(err.message)) throw err;
          container = await downloadHls(job, url, headers);
        }
      }

      if (job.cancelled) throw new Error('cancelled');

      job.status = 'finalizing';
      job.updatedAt = now();
      if (container.kind === 'hls') {
        await registerHls({ id: key, title: job.title, source: url });
      } else {
        const finalPath = mediaPath(key, container.ext);
        await rename(job.tempPath, finalPath);
        await registerMedia({
          id: key,
          title: job.title,
          file: finalPath,
          ext: container.ext,
          source: url,
        });
      }

      job.playable = container.playable;
      job.container = container;
      job.status = 'done';
      job.updatedAt = now();
    } catch (err) {
      job.status = job.cancelled ? 'cancelled' : 'error';
      job.error = err.message;
      job.updatedAt = now();
      // A failed HLS job keeps its segment files — the next attempt resumes.
      await rm(job.tempPath, { force: true }).catch(() => {});
    }
  })();

  return jobView(job);
}

/** File size on disk for a finished job, used by the health route. */
export async function downloadSize(id) {
  const job = jobs.get(String(id));
  if (!job) return null;
  const info = await stat(job.tempPath).catch(() => null);
  return info?.size ?? null;
}
