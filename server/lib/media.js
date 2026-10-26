import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { dataPath } from './paths.js';
import { dashBytes, dashDir, readDashManifest, removeDash } from './dashstore.js';
import { hlsBytes, hlsDir, readHlsManifest, removeHls } from './hlsstore.js';
import { probeTsDuration } from './tsprobe.js';

/**
 * Local media store.
 *
 * Downloads land as one file per title in `<data>/media/`, described by
 * `<data>/media.json`. Nothing here touches the network — this module only knows
 * how to remember what exists and how to hand bytes back to a <video> tag with
 * the range semantics that seeking needs.
 */

const MEDIA_DIR = () => dataPath('media');
const MANIFEST = () => dataPath('media.json');

const MIME = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.ts': 'video/mp2t',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
};

const entries = new Map();
let loaded = false;
let flushChain = Promise.resolve();
let dirty = false;
let flushTimer = null;

/** Ids become file names, so keep them to the namespaces the catalog uses. */
export function safeKey(id) {
  return String(id ?? '').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120);
}

export function mediaPath(id, ext = '.mp4') {
  return join(MEDIA_DIR(), `${safeKey(id)}${ext}`);
}

export function hasMedia(id) {
  return entries.has(String(id));
}

export function mediaFor(id) {
  return entries.get(String(id)) ?? null;
}

export function allMedia() {
  return [...entries.values()].sort((a, b) => b.createdAt - a.createdAt);
}

export async function loadMedia() {
  if (loaded) return;
  loaded = true;
  await mkdir(MEDIA_DIR(), { recursive: true }).catch(() => {});
  try {
    const parsed = JSON.parse(await readFile(MANIFEST(), 'utf8'));
    for (const [id, entry] of Object.entries(parsed?.items ?? {})) {
      // A downloaded DASH title is a directory of segments, not one file.
      if (entry.kind === 'dash') {
        const manifest = await readDashManifest(id);
        if (!manifest) continue;
        entries.set(id, { ...entry, duration: manifest.duration ?? entry.duration ?? null });
        continue;
      }
      // So is a downloaded HLS title: one file per playlist segment.
      if (entry.kind === 'hls') {
        const manifest = await readHlsManifest(id);
        if (!manifest) continue;
        entries.set(id, { ...entry, duration: manifest.duration ?? entry.duration ?? null });
        continue;
      }
      // A manifest entry with no file on disk is a stale download, not a hit.
      const info = await stat(entry.file).catch(() => null);
      if (!info) continue;
      // Older entries predate the duration probe; fill it in once, on load.
      if (entry.ext === '.ts' && entry.duration == null) {
        entry.duration = await probeTsDuration(entry.file);
        dirty = true;
      }
      entries.set(id, { ...entry, bytes: info.size });
    }
    if (dirty) await flush();
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`[media] manifest unreadable: ${err.message} — starting empty`);
    }
  }
}

function touch() {
  dirty = true;
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flush().catch((err) => console.warn(`[media] flush failed: ${err.message}`));
  }, 250);
  flushTimer.unref?.();
}

function flush() {
  if (!dirty) return flushChain;
  dirty = false;
  const snapshot = JSON.stringify({ items: Object.fromEntries(entries) }, null, 2);
  flushChain = flushChain.then(async () => {
    await mkdir(dirname(MANIFEST()), { recursive: true });
    const tmp = `${MANIFEST()}.${process.pid}.tmp`;
    await writeFile(tmp, snapshot, 'utf8');
    await rename(tmp, MANIFEST());
  });
  return flushChain;
}

export async function registerMedia(entry) {
  const key = String(entry.id);
  const info = await stat(entry.file);
  const ext = entry.ext ?? '.mp4';
  // A transport stream has no duration field; the probe reads the PTS span so
  // the player can offer a real scrubber instead of an unbounded timeline.
  const duration = entry.duration ?? (ext === '.ts' ? await probeTsDuration(entry.file) : null);
  const record = {
    id: key,
    title: entry.title ?? key,
    file: entry.file,
    ext,
    mime: MIME[ext] ?? 'video/mp4',
    bytes: info.size,
    duration: duration ?? null,
    source: entry.source ?? 'download',
    createdAt: Date.now(),
  };
  entries.set(key, record);
  touch();
  await flush();
  return record;
}

/**
 * Register a finished HLS download. The manifest on disk already knows the
 * duration, segment count and codec list, so this only records the index entry.
 */
export async function registerHls({ id, title = null, source = 'download' }) {
  const key = String(id);
  const manifest = await readHlsManifest(key);
  if (!manifest) throw new Error('hls manifest missing after download');
  const record = {
    id: key,
    title: title ?? manifest.title ?? key,
    kind: 'hls',
    dir: hlsDir(key),
    ext: 'hls',
    mime: manifest.mime ?? 'video/mp2t',
    bytes: manifest.bytes ?? (await hlsBytes(key)),
    duration: manifest.duration ?? null,
    segments: manifest.segments,
    source,
    createdAt: Date.now(),
  };
  entries.set(key, record);
  touch();
  await flush();
  return record;
}

export async function registerDash({ id, title, duration = null, segments = 0 }) {
  const key = String(id);
  const bytes = await dashBytes(key);
  const record = {
    id: key,
    title: title ?? key,
    kind: 'dash',
    dir: dashDir(key),
    ext: 'dash',
    mime: 'application/dash+xml',
    bytes,
    duration: duration ?? null,
    segments,
    source: 'download',
    createdAt: Date.now(),
  };
  entries.set(key, record);
  touch();
  await flush();
  return record;
}

export async function removeMedia(id) {
  const key = String(id);
  const record = entries.get(key);
  if (!record) return false;
  entries.delete(key);
  touch();
  await flush();
  if (record.kind === 'dash') {
    await removeDash(key);
  } else if (record.kind === 'hls') {
    await removeHls(key);
  } else {
    await rm(record.file, { force: true }).catch(() => {});
  }
  return true;
}

/**
 * Serve a stored file with HTTP range support. `HEAD` and open-ended ranges are
 * both handled, because seeking in a <video> element depends on 206 responses
 * with a correct Content-Range.
 */
export async function serveMedia(req, res, id) {
  const record = entries.get(String(id));
  if (!record) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not downloaded' }));
    return;
  }

  // A DASH download is a directory of segments; the player fetches those
  // through /api/local-dash. An HLS download is the same shape, served per
  // segment through /api/local-hls. One file cannot represent either.
  if (record.kind === 'dash' || record.kind === 'hls') {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: `${record.kind} media is served per segment` }));
    return;
  }

  const info = await stat(record.file).catch(() => null);
  if (!info) {
    entries.delete(String(id));
    touch();
    res.writeHead(410, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'file gone' }));
    return;
  }

  const total = info.size;
  const range = req.headers.range;
  const headers = {
    'content-type': record.mime ?? 'video/mp4',
    'accept-ranges': 'bytes',
    'cache-control': 'public, max-age=3600',
    'content-disposition': `inline; filename="${encodeURIComponent(record.title)}${record.ext ?? '.mp4'}"`,
  };

  if (!range) {
    res.writeHead(200, { ...headers, 'content-length': total });
    if (req.method === 'HEAD') return res.end();
    createReadStream(record.file).pipe(res);
    return;
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
  if (!match) {
    res.writeHead(416, { 'content-range': `bytes */${total}` });
    return res.end();
  }

  let start = match[1] === '' ? null : Number(match[1]);
  let end = match[2] === '' ? null : Number(match[2]);
  if (start === null && end === null) {
    res.writeHead(416, { 'content-range': `bytes */${total}` });
    return res.end();
  }
  // `bytes=-5000` means the last 5000 bytes, not a range starting at zero.
  if (start === null) {
    start = Math.max(0, total - end);
    end = total - 1;
  } else if (end === null || end >= total) {
    end = total - 1;
  }
  if (start > end || start >= total) {
    res.writeHead(416, { 'content-range': `bytes */${total}` });
    return res.end();
  }

  res.writeHead(206, {
    ...headers,
    'content-range': `bytes ${start}-${end}/${total}`,
    'content-length': end - start + 1,
  });
  if (req.method === 'HEAD') return res.end();
  createReadStream(record.file, { start, end }).pipe(res);
}

export function mediaStats() {
  const items = allMedia();
  return {
    count: items.length,
    bytes: items.reduce((sum, item) => sum + (item.bytes ?? 0), 0),
  };
}
