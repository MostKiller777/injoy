import { createDecipheriv } from 'node:crypto';
import { mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { registerMedia, mediaPath, safeKey } from './media.js';

/**
 * Download engine.
 *
 * Two shapes arrive from the embed resolvers: a progressive file, or an HLS
 * playlist. Both end as one file on disk, because one file is what a <video>
 * tag and a byte-range request can seek through.
 *
 * HLS handling that matters in practice:
 * - master playlists: pick the highest-bandwidth variant
 * - `#EXT-X-MAP`: prepend the init segment (this is what makes the result a
 *   fragmented MP4 instead of an unplayable bag of fragments)
 * - `#EXT-X-KEY` AES-128: decrypt per segment, explicit IV or sequence number
 * - `#EXT-X-BYTERANGE`: sub-range requests against a single hosting file
 * - segments download out of order but write in order, so a slow segment never
 *   reorders the timeline
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36';
const CONCURRENCY = 6;
const REQUEST_TIMEOUT = 30_000;
const MAX_SEGMENTS = 20_000;

export const jobs = new Map();

const now = () => Date.now();

function jobView(job) {
  const elapsed = Math.max(1, now() - job.startedAt) / 1000;
  return {
    id: job.id,
    title: job.title,
    status: job.status,
    bytes: job.bytes,
    total: job.total,
    percent: job.total > 0 ? Math.min(100, Math.round((job.bytes / job.total) * 100)) : null,
    segmentsDone: job.segmentsDone,
    segmentsTotal: job.segmentsTotal,
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
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} ${url.slice(0, 120)}`);
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
    pendingRange = null;
  }

  return { segments: segments.slice(0, MAX_SEGMENTS), map };
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

/** Decide the saved container from what the playlist actually contains. */
function containerFor(map, firstSegment) {
  if (map) return { ext: '.mp4', playable: true };
  const name = (firstSegment?.url ?? '').toLowerCase();
  if (name.includes('.mp4') || name.includes('.m4s')) return { ext: '.mp4', playable: true };
  return { ext: '.ts', playable: false };
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

async function downloadHls(job, url, headers) {
  const media = await resolveMediaPlaylist(url, headers, job.controller.signal);
  const { segments, map } = parseSegments(media.url, media.text);
  if (!segments.length) throw new Error('playlist has no segments');

  const container = containerFor(map, segments[0]);
  const keyCache = new Map();
  job.segmentsTotal = segments.length;
  job.container = container;

  await mkdir(dirname(job.tempPath), { recursive: true });
  const handle = await open(job.tempPath, 'w');
  let writeCursor = 0;

  try {
    if (map) {
      const { header } = rangeHeader(map.range, 0);
      const { buffer } = await request(map.url, {
        headers: header ? { ...headers, range: header } : headers,
        signal: job.controller.signal,
      });
      await handle.write(buffer, 0, buffer.length, writeCursor);
      writeCursor += buffer.length;
      job.bytes += buffer.length;
    }

    // Sliding window: keep CONCURRENCY fetches in flight, write strictly in
    // playlist order so the byte stream stays a valid timeline.
    const pending = new Map();
    let nextToStart = 0;
    let nextToWrite = 0;
    let failure = null;

    const startOne = (index) => {
      const promise = fetchSegment(segments[index], headers, job.controller.signal, keyCache, 0)
        .then((buffer) => ({ index, buffer }))
        .catch((err) => ({ index, error: err }));
      pending.set(index, promise);
    };

    while (nextToWrite < segments.length) {
      if (job.cancelled) throw new Error('cancelled');
      if (failure) throw failure;

      while (pending.size < CONCURRENCY && nextToStart < segments.length) {
        startOne(nextToStart);
        nextToStart += 1;
      }

      const settled = await pending.get(nextToWrite);
      pending.delete(nextToWrite);
      if (settled.error) {
        failure = settled.error;
        continue;
      }

      await handle.write(settled.buffer, 0, settled.buffer.length, writeCursor);
      writeCursor += settled.buffer.length;
      job.bytes += settled.buffer.length;
      job.segmentsDone += 1;
      job.updatedAt = now();
      nextToWrite += 1;
    }
  } finally {
    await handle.close();
  }

  return container;
}

/**
 * Kick off a download. Returns the job view immediately; the work continues in
 * the background and is polled through `jobFor`.
 *
 * With no `url` the job is only registered as `resolving` — the route uses that
 * to claim the id while a headless browser looks for a stream, so the client
 * polls one id from the first second instead of racing a second request.
 */
export function startDownload({ id, title, url, referer, origin }) {
  const key = String(id);
  if (!key) throw new Error('id required');

  const existing = jobs.get(key);
  const active = existing && !['error', 'cancelled', 'done', 'resolving'].includes(existing.status);
  if (active) return jobView(existing);

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

  if (!url) return jobView(job);

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
      const finalPath = mediaPath(key, container.ext);
      await rename(job.tempPath, finalPath);
      await registerMedia({
        id: key,
        title: job.title,
        file: finalPath,
        ext: container.ext,
        source: url,
      });

      job.playable = container.playable;
      job.container = container;
      job.status = 'done';
      job.updatedAt = now();
    } catch (err) {
      job.status = job.cancelled ? 'cancelled' : 'error';
      job.error = err.message;
      job.updatedAt = now();
      await rm(job.tempPath, { force: true }).catch(() => {});
    }
  })();

  return jobView(job);
}

/** Mark a resolving job as failed, so the client stops polling. */
export function failJob(id, message) {
  const job = jobs.get(String(id));
  if (!job) return false;
  job.status = 'error';
  job.error = message;
  job.updatedAt = now();
  return true;
}

/** File size on disk for a finished job, used by the health route. */
export async function downloadSize(id) {
  const job = jobs.get(String(id));
  if (!job) return null;
  const info = await stat(job.tempPath).catch(() => null);
  return info?.size ?? null;
}
