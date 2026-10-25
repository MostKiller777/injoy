import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

import { loadEnv } from './lib/env.js';
import { Cache } from './lib/cache.js';
import { Store } from './lib/store.js';
import { isAllowedImage } from './lib/images.js';
import { dataPath, dataRoot } from './lib/paths.js';
import * as catalog from './lib/catalog.js';
import { allMedia, loadMedia, mediaFor, mediaStats, removeMedia, serveMedia } from './lib/media.js';
import { allJobs, cancelDownload, failJob, jobFor, startDownload } from './lib/downloader.js';
import { resolveStream } from './lib/resolver.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
loadEnv(join(ROOT, '.env'));

const PORT = Number(process.env.PORT || 6967);
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = join(ROOT, 'public');
const DATA_FILE = dataPath('library.json');

const cache = new Cache({ max: 1500, ttl: 60_000 });
const imageCache = new Cache({ max: 320, ttl: 10 * 60_000 });
const store = await new Store(DATA_FILE).load();
await loadMedia();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-frame-options': 'SAMEORIGIN',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  'content-security-policy': [
    "default-src 'self'",
    "img-src 'self' data: blob: https:",
    "media-src 'self' https: blob:",
    "frame-src https:",
    "connect-src 'self' https:",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self'",
    "font-src 'self' data:",
    "manifest-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; '),
};

const gzipCache = new Map();

function json(res, status, payload, extra = {}) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
    ...SECURITY_HEADERS,
    ...extra,
  });
  res.end(body);
}

function fail(res, status, message) {
  json(res, status, { error: message, status });
}

async function readBody(req, limit = 262_144) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      const error = new Error('payload too large');
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    const error = new Error('invalid JSON body');
    error.status = 400;
    throw error;
  }
}

/* ------------------------------- static -------------------------------- */

function serveAsset(req, res, pathname) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  const filePath = resolve(join(PUBLIC_DIR, `.${requested}`));
  const prefix = PUBLIC_DIR.endsWith(sep) ? PUBLIC_DIR : PUBLIC_DIR + sep;
  if (!filePath.startsWith(prefix)) return fail(res, 403, 'forbidden');

  return stat(filePath)
    .then(async (info) => {
      if (!info.isFile()) throw Object.assign(new Error('not found'), { code: 'ENOENT' });
      const type = MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
      const etag = `W/"${info.size}-${Math.floor(info.mtimeMs)}"`;

      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, { etag, ...SECURITY_HEADERS });
        res.end();
        return;
      }

      const isText = /text|json|javascript|svg|manifest/.test(type);
      const headers = {
        'content-type': type,
        etag,
        'cache-control': isText ? 'no-cache' : 'public, max-age=86400',
        ...SECURITY_HEADERS,
      };

      const acceptsGzip = /\bgzip\b/.test(req.headers['accept-encoding'] ?? '');
      if (isText && acceptsGzip && info.size > 1024) {
        const key = `${filePath}:${info.mtimeMs}`;
        let compressed = gzipCache.get(key);
        if (!compressed) {
          compressed = gzipSync(await readFileBuffer(filePath));
          if (gzipCache.size > 64) gzipCache.clear();
          gzipCache.set(key, compressed);
        }
        headers['content-encoding'] = 'gzip';
        headers['content-length'] = compressed.length;
        headers.vary = 'accept-encoding';
        res.writeHead(200, headers);
        res.end(res.req.method === 'HEAD' ? undefined : compressed);
        return;
      }

      headers['content-length'] = info.size;
      res.writeHead(200, headers);
      if (req.method === 'HEAD') return res.end();
      createReadStream(filePath).pipe(res);
    })
    .catch((err) => {
      if (err.code === 'ENOENT') {
        // SPA fallback: unknown extension-less path renders the shell.
        if (!extname(requested)) {
          req.url = '/index.html';
          return serveAsset(req, res, '/index.html');
        }
        return fail(res, 404, 'not found');
      }
      return fail(res, 500, 'static failure');
    });
}

async function readFileBuffer(filePath) {
  const { readFile } = await import('node:fs/promises');
  return readFile(filePath);
}

/* -------------------------------- api ---------------------------------- */

const hits = new Map();
function rateLimit(req) {
  const key = req.socket.remoteAddress ?? 'local';
  const now = Date.now();
  const bucket = hits.get(key) ?? { count: 0, reset: now + 60_000 };
  if (now > bucket.reset) {
    bucket.count = 0;
    bucket.reset = now + 60_000;
  }
  bucket.count += 1;
  hits.set(key, bucket);
  return bucket.count <= 600;
}

setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of hits) if (bucket.reset < now) hits.delete(key);
}, 60_000).unref();

function miniItem(item) {
  return {
    id: item.id,
    source: item.source,
    kind: item.kind ?? 'film',
    title: item.title,
    year: item.year ?? null,
    poster: item.poster ?? null,
    backdrop: item.backdrop ?? null,
    rating: item.rating ?? null,
    runtime: item.runtime ?? null,
    overview: item.overview ?? '',
    genres: item.genres ?? [],
    tmdbId: item.tmdbId ?? null,
    seasons: item.seasons ?? null,
    episodes: item.episodes ?? null,
  };
}

async function handleApi(req, res, url) {
  const { pathname, searchParams } = url;
  const method = req.method ?? 'GET';

  // Image proxy — allowlisted hosts only, cached in memory, exempt from the
  // API budget because a single grid can request dozens of posters.
  if (pathname === '/api/img') {
    const target = searchParams.get('u') ?? '';
    if (!isAllowedImage(target)) return fail(res, 400, 'image host not allowed');
    try {
      const image = await imageCache.wrap(target, 6 * 60 * 60_000, async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15_000);
        try {
          const upstream = await fetch(target, {
            signal: controller.signal,
            headers: { 'user-agent': 'injoy/1.0', accept: 'image/*' },
            redirect: 'follow',
          });
          if (!upstream.ok) throw Object.assign(new Error(`upstream ${upstream.status}`), { status: 502 });
          const type = upstream.headers.get('content-type') ?? '';
          if (!type.startsWith('image/')) throw Object.assign(new Error('not an image'), { status: 415 });
          const buffer = Buffer.from(await upstream.arrayBuffer());
          if (buffer.length > 8_000_000) throw Object.assign(new Error('image too large'), { status: 413 });
          return { type, buffer };
        } finally {
          clearTimeout(timer);
        }
      });

      res.writeHead(200, {
        'content-type': image.type,
        'content-length': image.buffer.length,
        'cache-control': 'public, max-age=86400',
        ...SECURITY_HEADERS,
      });
      return req.method === 'HEAD' ? res.end() : res.end(image.buffer);
    } catch (err) {
      return fail(res, err.status ?? 502, err.message);
    }
  }

  if (!rateLimit(req)) return fail(res, 429, 'slow down');

  // health
  if (pathname === '/api/health') {
    return json(res, 200, {
      ok: true,
      uptime: Math.round(process.uptime()),
      mode: 'curated',
      cache: cache.stats(),
      library: { watchlist: store.list().length, progress: Object.keys(store.allProgress()).length },
      media: mediaStats(),
      dataDir: dataRoot(),
      version: '1.1.0',
    });
  }

  // home
  if (pathname === '/api/home') {
    const data = await cache.wrap('home', catalog.TTL.home, () => catalog.home());
    return json(res, 200, data);
  }

  // search
  if (pathname === '/api/search') {
    const q = (searchParams.get('q') ?? '').trim();
    if (!q) return json(res, 200, { items: [], page: 1, totalPages: 0 });
    const page = Math.max(1, Math.min(20, Number(searchParams.get('page')) || 1));
    const key = `search:${q.toLowerCase()}:${page}`;
    const data = await cache.wrap(key, catalog.TTL.search, () => catalog.searchTitles(q, page));
    return json(res, 200, data);
  }

  // browse
  if (pathname === '/api/browse') {
    const page = Math.max(1, Math.min(20, Number(searchParams.get('page')) || 1));
    const genre = searchParams.get('genre') ?? '';
    const sort = searchParams.get('sort') ?? 'popular';
    const key = `browse:${genre}:${sort}:${page}`;
    const data = await cache.wrap(key, catalog.TTL.search, () => catalog.browse({ page, genre, sort }));
    return json(res, 200, data);
  }

  // genres
  if (pathname === '/api/genres') {
    const data = await cache.wrap('genres', 60 * 60_000, () => catalog.genres());
    return json(res, 200, data);
  }

  // series shelf
  if (pathname === '/api/series') {
    const data = await cache.wrap('series', 30 * 60_000, () => catalog.seriesShelf());
    return json(res, 200, data);
  }

  // random
  if (pathname === '/api/random') {
    const item = await catalog.randomPick();
    if (!item) return fail(res, 503, 'no catalog available');
    return json(res, 200, { item });
  }

  // detail
  const detailMatch = /^\/api\/movie\/(.+)$/.exec(pathname);
  if (detailMatch && method === 'GET') {
    const id = decodeURIComponent(detailMatch[1]);
    try {
      const data = await cache.wrap(`detail:${id}`, catalog.TTL.detail, () => catalog.detail(id));
      return json(res, 200, data);
    } catch (err) {
      return fail(res, err.status ?? 502, err.message);
    }
  }

  // sources
  const sourcesMatch = /^\/api\/sources\/(.+)$/.exec(pathname);
  if (sourcesMatch && method === 'GET') {
    const id = decodeURIComponent(sourcesMatch[1]);
    try {
      const data = await cache.wrap(`sources:${id}`, catalog.TTL.detail, () => catalog.sources(id));
      return json(res, 200, data);
    } catch (err) {
      return fail(res, err.status ?? 502, err.message);
    }
  }

  // local media: what is on disk, plus anything mid-download
  if (pathname === '/api/local' && method === 'GET') {
    return json(res, 200, { items: allMedia(), jobs: allJobs(), stats: mediaStats() });
  }

  // byte-range stream for a downloaded title — this is what <video> points at
  const streamMatch = /^\/api\/stream\/(.+)$/.exec(pathname);
  if (streamMatch && (method === 'GET' || method === 'HEAD')) {
    return serveMedia(req, res, decodeURIComponent(streamMatch[1]));
  }

  // download control
  const downloadMatch = /^\/api\/download\/(.+)$/.exec(pathname);
  if (downloadMatch) {
    const id = decodeURIComponent(downloadMatch[1]);

    if (method === 'GET') {
      const job = jobFor(id);
      const media = mediaFor(id);
      return json(res, 200, { id, job, media });
    }

    if (method === 'DELETE') {
      cancelDownload(id);
      const removed = await removeMedia(id);
      return json(res, 200, { removed });
    }

    if (method === 'POST') {
      const body = await readBody(req);
      const title = body?.title ?? id;

      if (body?.url) {
        const job = startDownload({ id, title, url: body.url, referer: body.referer });
        return json(res, 202, { id, job });
      }

      // No URL supplied: resolve one from the embed chain first. This is the
      // slow path — a headless browser per provider — so the job is registered
      // as `resolving` before the search starts and the client polls the same
      // endpoint the whole way through.
      const meta = await catalog.detail(id).catch(() => null);
      if (!meta) return fail(res, 404, 'title not found');

      const tmdbId = meta.tmdbId ?? String(id).replace(/^tmdb:/, '');
      const imdbId = meta.imdbId ?? null;
      const [kind, , season, episode] = String(id).split(':');

      const job = startDownload({ id, title: meta.title ?? title });

      resolveStream({
        tmdbId,
        imdbId,
        season: kind === 'tv' ? Number(season) || 1 : null,
        episode: kind === 'tv' ? Number(episode) || 1 : null,
      }).then((found) => {
        if (!found.url) {
          failJob(id, found.error ?? 'no provider produced a stream');
          return;
        }
        startDownload({
          id,
          title: meta.title ?? title,
          url: found.url,
          referer: found.referer,
        });
      }).catch((err) => failJob(id, err.message));

      return json(res, 202, { id, job, resolving: true });
    }
  }

  // watchlist
  if (pathname === '/api/watchlist' && method === 'GET') {
    return json(res, 200, { items: store.list() });
  }

  if (pathname === '/api/watchlist' && method === 'POST') {
    const body = await readBody(req);
    if (!body?.item?.id) return fail(res, 400, 'item required');
    const saved = store.add(miniItem(body.item));
    return json(res, 201, { item: saved, items: store.list() });
  }

  const watchMatch = /^\/api\/watchlist\/(.+)$/.exec(pathname);
  if (watchMatch && method === 'DELETE') {
    const id = decodeURIComponent(watchMatch[1]);
    const removed = store.remove(id);
    return json(res, 200, { removed, items: store.list() });
  }

  // progress
  if (pathname === '/api/progress' && method === 'GET') {
    return json(res, 200, { progress: store.allProgress() });
  }

  const progressMatch = /^\/api\/progress\/(.+)$/.exec(pathname);
  if (progressMatch && method === 'POST') {
    const id = decodeURIComponent(progressMatch[1]);
    const body = await readBody(req);
    const entry = store.setProgress(id, Number(body.t), Number(body.d));
    if (!entry) return fail(res, 400, 't required');
    return json(res, 200, { id, progress: entry });
  }

  if (progressMatch && method === 'DELETE') {
    const id = decodeURIComponent(progressMatch[1]);
    store.data.progress[id] && delete store.data.progress[id];
    store.touch();
    return json(res, 200, { removed: true });
  }

  return fail(res, 404, 'unknown endpoint');
}

/* ------------------------------- server -------------------------------- */

const server = createServer(async (req, res) => {
  const started = Date.now();
  let url;
  try {
    url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  } catch {
    return fail(res, 400, 'bad request');
  }

  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
      if (process.env.LOG_API !== '0') {
        console.log(`${req.method} ${url.pathname}${url.search} → ${res.statusCode} (${Date.now() - started}ms)`);
      }
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return fail(res, 405, 'method not allowed');
    }

    return serveAsset(req, res, decodeURIComponent(url.pathname));
  } catch (err) {
    console.error(`[server] ${req.method} ${url.pathname}: ${err.stack ?? err.message}`);
    if (!res.headersSent) fail(res, err.status ?? 500, err.message ?? 'internal error');
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  const mode = 'Curated catalog — eight genre rails';
  console.log('');
  console.log(`  injoy  —  http://${HOST}:${PORT}`);
  console.log(`  mode     —  ${mode}`);
  console.log(`  library  —  ${DATA_FILE}`);
  console.log('');
});

let closing = false;
async function shutdown(signal) {
  if (closing) return;
  closing = true;
  console.log(`\n[server] ${signal} — flushing library`);
  try {
    await store.flush();
  } finally {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
