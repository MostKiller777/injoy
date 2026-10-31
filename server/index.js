import { createServer } from 'node:http';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
import { allJobs, cancelDownload, jobFor, startDashDownload, startDownload } from './lib/downloader.js';
import { createDashSession, loadDashManifest, openDashSession, readSegment, switchDashVariant } from './lib/dash.js';
import { openHlsSession, readHlsSegment, switchHlsVariant } from './lib/hls.js';
import { openRawSession, readRaw } from './lib/raw.js';
import { resolveStream } from './lib/resolver.js';
import { dashSession, readDashSegment } from './lib/dashstore.js';
import { hlsSession, readLocalHlsSegment } from './lib/hlsstore.js';
import { seriesStreamTarget } from './lib/series.js';
import { subtitleTracks, subtitleVtt } from './lib/subtitles.js';
import { addCustomFilm, curatedDetail, customFilmList, isCurated, removeCustomFilm } from './lib/curated.js';
import { filmFromImdb, searchMovies } from './lib/cinemeta.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
loadEnv(join(ROOT, '.env'));

const PORT = Number(process.env.PORT || 6967);
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = join(ROOT, 'public');
const DATA_FILE = dataPath('library.json');

/**
 * Admin password.
 *
 * `ADMIN_KEY` in the environment wins. Otherwise a random password is made on
 * first boot and kept in `data/admin-key.txt`; the panel is private without the
 * user having to configure anything, and the password survives restarts.
 */
function loadAdminKey() {
  const fromEnv = String(process.env.ADMIN_KEY ?? '').trim();
  if (fromEnv) return fromEnv;

  const file = dataPath('admin-key.txt');
  try {
    const saved = readFileSync(file, 'utf8').trim();
    if (saved) return saved;
  } catch {
    // first boot
  }

  const key = randomBytes(24).toString('hex');
  try {
    mkdirSync(dataRoot(), { recursive: true });
    writeFileSync(file, `${key}\n`, { mode: 0o600 });
    console.log(`[admin] generated a private password in ${file}`);
  } catch (err) {
    console.warn(`[admin] could not save the password to ${file}: ${err.message}`);
  }
  return key;
}

const ADMIN_KEY = loadAdminKey();

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

/**
 * The fields a card or rail actually paints.
 *
 * A catalogue item carries the overview, the source list, TMDB bookkeeping and
 * a dozen other fields a poster card never reads. Shipping all of it for every
 * tile made `/api/home` 480 KB of JSON for 236 cards. The detail endpoint still
 * returns the whole record; list endpoints return what the list renders.
 */
function cardItem(item) {
  return {
    id: item.id,
    kind: item.kind,
    title: item.title,
    year: item.year,
    poster: item.poster,
    rating: item.rating,
    badge: item.badge,
    genres: item.genres,
    seasons: item.seasons,
    episodes: item.episodes,
    network: item.network,
  };
}

const cardPage = (data) => ({ ...data, items: (data.items ?? []).map(cardItem) });

function json(res, status, payload, extra = {}) {
  const body = Buffer.from(JSON.stringify(payload));
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...SECURITY_HEADERS,
    ...extra,
  };

  // The home payload is hundreds of kilobytes of catalogue metadata. Static
  // files were already compressed; JSON was not, so the first paint waited on
  // the full object graph over the wire. Compress anything worth compressing
  // and keep the length honest for the client.
  const acceptsGzip = /\bgzip\b/i.test(res.req?.headers?.['accept-encoding'] ?? '');
  if (acceptsGzip && body.length > 1024) {
    const compressed = gzipSync(body);
    headers['content-encoding'] = 'gzip';
    headers['content-length'] = compressed.length;
    headers.vary = 'accept-encoding';
    res.writeHead(status, headers);
    res.end(compressed);
    return;
  }

  headers['content-length'] = body.length;
  res.writeHead(status, headers);
  res.end(body);
}

function fail(res, status, message) {
  json(res, status, { error: message, status });
}

/**
 * Where the resolver should look for a title: films carry a TMDB id on their
 * detail record, series episodes carry theirs in the frozen IMDb map.
 */
function streamTarget(id, meta = null) {
  const [kind, raw, season, episode] = String(id).split(':');
  if (kind === 'tv') {
    const target = seriesStreamTarget(id);
    return target
      ? { tmdbId: target.tmdbId, imdbId: target.imdbId, season: target.season, episode: target.episode }
      : null;
  }
  return {
    tmdbId: meta?.tmdbId ?? raw ?? null,
    imdbId: meta?.imdbId ?? null,
    season: null,
    episode: null,
  };
}

/**
 * The catalog keys series by show (`tv:<tvmazeId>`); an episode id carries two
 * more segments. Metadata lives on the show, so look it up without the coords.
 */
function baseIdFor(id) {
  const parts = String(id).split(':');
  return parts[0] === 'tv' ? parts.slice(0, 2).join(':') : String(id);
}

/**
 * Where a title's captions live.
 *
 * Series carry an IMDb id in the frozen map and their episode coordinates.
 * Films carry neither, so the subtitles module matches one from the title and
 * year and keeps the answer.
 */
async function captionTarget(id, duration = null, fps = null) {
  const [kind] = String(id).split(':');
  const frameRate = Number.isFinite(fps) && fps > 0 ? fps : null;
  if (kind === 'tv') {
    const target = seriesStreamTarget(id);
    if (!target?.imdbId) return null;
    return {
      id,
      title: target.title ?? null,
      year: null,
      imdbId: target.imdbId,
      season: target.season,
      episode: target.episode,
      duration: Number.isFinite(duration) && duration > 0 ? duration : target.duration,
      fps: frameRate,
    };
  }
  const meta = await catalog.detail(id).catch(() => null);
  return {
    id,
    title: meta?.title ?? null,
    year: meta?.year ?? null,
    imdbId: null,
    season: null,
    episode: null,
    duration: Number.isFinite(duration) && duration > 0 ? duration : Number(meta?.runtime) || null,
    fps: frameRate,
  };
}

// Background caching is a courtesy, not a promise: one at a time, and only
// while the media folder stays under its budget.
const CACHE_MAX_BYTES = Number(process.env.MEDIA_CACHE_GB ?? 40) * 1024 ** 3;
const CACHE_CONCURRENCY = 1;

function cacheSlotAvailable() {
  const active = allJobs().filter((job) => ['resolving', 'downloading', 'finalizing'].includes(job.status));
  return active.length < CACHE_CONCURRENCY && mediaStats().bytes < CACHE_MAX_BYTES;
}

// One resolver run per title, even when several tabs press play together.
const playInflight = new Map();

// A headless browser sniff is the slowest part of starting a stream. The
// upstream URL it finds stays valid for minutes, so the next play of the same
// episode can skip the browser entirely.
const resolveCache = new Map();
const RESOLVE_TTL = 10 * 60_000;
const RESOLVE_NEGATIVE_TTL = 60_000;
const PLAY_DEADLINE_MS = 4_500;

// A resolved DASH manifest is also expensive to fetch. Cache the playable
// record (never the per-play session id) so the second press of play is a
// session build, not another provider round trip.
const playableCache = new Map();
const PLAYABLE_TTL = 5 * 60_000;

const resolveKey = (target) => [
  target.tmdbId ?? '',
  target.imdbId ?? '',
  target.season ?? '',
  target.episode ?? '',
].join('|');

async function resolveUpstream(target) {
  const key = resolveKey(target);
  const hit = resolveCache.get(key);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.value;

  const value = await resolveStream(target);
  if (resolveCache.size > 500) resolveCache.clear();
  resolveCache.set(key, {
    at: Date.now(),
    ttl: value.url ? RESOLVE_TTL : RESOLVE_NEGATIVE_TTL,
    value,
  });
  return value;
}

/** Let the direct resolver race a deadline; the caller falls back to an embed. */
function withDeadline(promise, ms) {
  let timer = null;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, timeout: true }), ms);
    timer.unref?.();
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/**
 * Resolve a title to something the player can mount.
 *
 * Providers answer in three shapes: DASH (two tracks, numbered fragments), HLS
 * (a playlist of muxed segments) and a plain progressive file. DASH needs its
 * manifest read and its tracks registered; HLS needs its playlist parsed and
 * proxied; progressive just needs a same-origin URL with Range support. All
 * three end up as a `direct` source, so the client never learns which one it
 * got — it mounts whatever session it is handed.
 */
async function resolvePlayableUncached(id, target) {
  const resolved = await resolveUpstream(target);
  if (!resolved.url) return { ok: false, error: resolved.error ?? 'no provider produced a stream' };

  const referer = resolved.referer ?? null;
  const page = resolved.page ?? null;

  if (resolved.type === 'dash') {
    const manifest = await loadDashManifest(resolved.url, referer);
    if (!manifest.ok) return { ok: false, error: manifest.error };
    return {
      ok: true,
      kind: 'dash',
      url: resolved.url,
      referer,
      page,
      duration: manifest.duration,
      video: manifest.video,
      videos: manifest.videos,
      audio: manifest.audio,
    };
  }

  if (resolved.type === 'hls') {
    const session = await openHlsSession({ id, url: resolved.url, referer });
    if (!session.ok) return { ok: false, error: session.error };
    const { ok: _ok, ...payload } = session;
    return { ok: true, kind: 'hls', url: resolved.url, referer, page, session: payload };
  }

  return {
    ok: true,
    kind: 'progressive',
    url: resolved.url,
    referer,
    page,
    session: openRawSession({ id, url: resolved.url, referer }),
  };
}

/**
 * Playable record with a short cache.
 *
 * HLS sessions are not cached: their payload describes one open session. DASH
 * and progressive records are just the manifest and track description, so they
 * can be reused while the route builds a fresh session around them.
 */
async function resolvePlayable(id, target) {
  const key = resolveKey(target);
  const hit = playableCache.get(key);
  if (hit && Date.now() - hit.at < PLAYABLE_TTL) return hit.value;

  const value = await resolvePlayableUncached(id, target);
  if (value.ok && value.kind !== 'hls') {
    if (playableCache.size > 200) playableCache.clear();
    playableCache.set(key, { at: Date.now(), value });
  }
  return value;
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

/**
 * Admin guard.
 *
 * With no `ADMIN_KEY` the panel is open, which is the right default for a
 * localhost install. A public host can set ADMIN_KEY in the service; the panel
 * sends it as `x-admin-key` and stores it in the browser.
 */
const ADMIN_SESSION_MS = 24 * 60 * 60_000;
const sha256 = (value) => createHash('sha256').update(String(value)).digest();
const sameSecret = (a, b) => timingSafeEqual(sha256(a), sha256(b));

/** A signed, expiring session cookie. The password is the signing key. */
function adminToken() {
  const expiry = Date.now() + ADMIN_SESSION_MS;
  const signature = createHmac('sha256', ADMIN_KEY).update(String(expiry)).digest('hex');
  return `${expiry}.${signature}`;
}

function adminCookie(req, value, maxAge) {
  const forwarded = String(req.headers['x-forwarded-proto'] ?? '');
  const secure = forwarded.includes('https') || Boolean(req.socket?.encrypted);
  return `injoy_admin=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

function adminFromCookie(req) {
  const raw = String(req.headers.cookie ?? '');
  const match = /(?:^|;\s*)injoy_admin=([^;]+)/.exec(raw);
  if (!match) return false;
  let decoded;
  try {
    decoded = decodeURIComponent(match[1]);
  } catch {
    return false;
  }
  const [expiryText, signature] = decoded.split('.');
  const expiry = Number(expiryText);
  if (!Number.isFinite(expiry) || expiry < Date.now() || !signature) return false;
  const expected = createHmac('sha256', ADMIN_KEY).update(String(expiry)).digest('hex');
  return sameSecret(signature, expected);
}

function adminAllowed(req, url) {
  const supplied = String(req.headers['x-admin-key'] ?? url.searchParams.get('key') ?? '');
  if (supplied) return sameSecret(supplied, ADMIN_KEY);
  return adminFromCookie(req);
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
        'cache-control': 'public, max-age=604800, immutable',
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
      version: '1.2.0',
    });
  }

  // admin authentication: password -> HttpOnly session cookie
  if (pathname === '/api/admin/session' && method === 'GET') {
    return json(res, 200, { authenticated: adminFromCookie(req) });
  }

  if (pathname === '/api/admin/login' && method === 'POST') {
    try {
      const body = await readBody(req);
      if (!sameSecret(String(body.key ?? ''), ADMIN_KEY)) {
        // A small fixed delay makes the endpoint a poor password oracle.
        await new Promise((resolve) => setTimeout(resolve, 250));
        return fail(res, 401, 'wrong password');
      }
      res.setHeader('set-cookie', adminCookie(req, adminToken(), Math.floor(ADMIN_SESSION_MS / 1000)));
      return json(res, 200, { ok: true });
    } catch (err) {
      return fail(res, 400, err.message);
    }
  }

  if (pathname === '/api/admin/logout' && method === 'POST') {
    res.setHeader('set-cookie', adminCookie(req, '', 0));
    return json(res, 200, { ok: true });
  }

  // admin: type a name, add the film
  if (pathname === '/api/admin/search' && method === 'GET') {
    if (!adminAllowed(req, url)) return fail(res, 401, 'admin key required');
    const query = (searchParams.get('q') ?? '').trim();
    if (query.length < 2) return json(res, 200, { results: [] });
    try {
      const results = await searchMovies(query);
      return json(res, 200, { results });
    } catch (err) {
      return fail(res, 502, err.message);
    }
  }

  if (pathname === '/api/admin/add' && method === 'POST') {
    if (!adminAllowed(req, url)) return fail(res, 401, 'admin key required');
    try {
      const body = await readBody(req);
      const film = await filmFromImdb(String(body.imdbId ?? ''));
      if (isCurated(film.tmdbId)) {
        return json(res, 200, {
          ok: true,
          already: true,
          item: curatedDetail(film.tmdbId) ?? {
            id: `tmdb:${film.tmdbId}`,
            title: film.title,
            year: film.year,
          },
        });
      }
      const item = addCustomFilm(film);
      cache.clear();
      return json(res, 200, { ok: true, added: true, item });
    } catch (err) {
      return fail(res, err.status ?? 502, err.message);
    }
  }

  if (pathname === '/api/admin/custom' && method === 'GET') {
    if (!adminAllowed(req, url)) return fail(res, 401, 'admin key required');
    return json(res, 200, {
      items: customFilmList().map(({ id, title, year, tmdbId, poster, rating }) => ({
        id, title, year, tmdbId, poster, rating,
      })),
    });
  }

  if (pathname === '/api/admin/remove' && method === 'POST') {
    if (!adminAllowed(req, url)) return fail(res, 401, 'admin key required');
    try {
      const body = await readBody(req);
      const removed = removeCustomFilm(body.tmdbId);
      if (!removed) return fail(res, 404, 'not a custom film');
      cache.clear();
      return json(res, 200, { ok: true, removed: true });
    } catch (err) {
      return fail(res, err.status ?? 500, err.message);
    }
  }

  // home
  if (pathname === '/api/home') {
    const data = await cache.wrap('home', catalog.TTL.home, () => catalog.home());
    return json(res, 200, {
      ...data,
      rows: (data.rows ?? []).map((row) => ({ ...row, items: (row.items ?? []).map(cardItem) })),
    });
  }

  // search
  if (pathname === '/api/search') {
    const q = (searchParams.get('q') ?? '').trim();
    if (!q) return json(res, 200, { items: [], page: 1, totalPages: 0 });
    const page = Math.max(1, Math.min(20, Number(searchParams.get('page')) || 1));
    const key = `search:${q.toLowerCase()}:${page}`;
    const data = await cache.wrap(key, catalog.TTL.search, () => catalog.searchTitles(q, page));
    return json(res, 200, cardPage(data));
  }

  // browse
  if (pathname === '/api/browse') {
    const page = Math.max(1, Math.min(20, Number(searchParams.get('page')) || 1));
    // Accept both the UI's id (`noir`, `scifi`) and a hand-typed label
    // (`Noir`, `Sci-Fi`). The catalogue keys genres by id.
    const genre = (searchParams.get('genre') ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '');
    const sort = searchParams.get('sort') ?? 'popular';
    const key = `browse:${genre}:${sort}:${page}`;
    const data = await cache.wrap(key, catalog.TTL.search, () => catalog.browse({ page, genre, sort }));
    return json(res, 200, cardPage(data));
  }

  // genres
  if (pathname === '/api/genres') {
    const data = await cache.wrap('genres', 60 * 60_000, () => catalog.genres());
    return json(res, 200, data);
  }

  // series shelf
  if (pathname === '/api/series') {
    const data = await cache.wrap('series', 30 * 60_000, () => catalog.seriesShelf());
    return json(res, 200, cardPage(data));
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

  // one playable source, chosen here — the visitor never picks and never downloads
  const playMatch = /^\/api\/play\/(.+)$/.exec(pathname);
  if (playMatch && method === 'GET') {
    const id = decodeURIComponent(playMatch[1]);

    // A copy on disk always wins: it seeks, it resumes, it needs no network.
    const media = mediaFor(id);
    if (media) {
      if (media.kind === 'dash') {
        const session = await dashSession(id);
        if (session) {
          return json(res, 200, {
            id,
            mode: 'local',
            source: {
              provider: 'local',
              label: 'Downloaded',
              kind: 'direct',
              container: 'dash',
              quality: session.video.height ? `${session.video.height}p` : 'source',
              duration: session.duration ?? null,
              session,
            },
          });
        }
      } else if (media.kind === 'hls') {
        // The saved copy is a directory of segments, so it plays through the
        // same HLS feeder a live stream does — pointed at this disk instead.
        const session = await hlsSession(id);
        if (session) {
          return json(res, 200, {
            id,
            mode: 'local',
            source: {
              provider: 'local',
              label: 'Downloaded',
              kind: 'direct',
              container: session.container,
              quality: session.quality ?? 'source',
              duration: session.duration ?? null,
              session,
            },
          });
        }
      } else {
        return json(res, 200, {
          id,
          mode: 'local',
          source: {
            provider: 'local',
            label: 'Downloaded',
            kind: 'direct',
            container: media.ext,
            quality: 'source',
            url: `/api/stream/${encodeURIComponent(id)}`,
            bytes: media.bytes,
            duration: media.duration ?? null,
          },
        });
      }
    }

    const meta = await catalog.detail(baseIdFor(id)).catch(() => null);
    if (!meta) return fail(res, 404, 'title not found');
    const target = streamTarget(id, meta);
    if (!target) return fail(res, 404, 'title not found');

    let pending = playInflight.get(id);
    if (!pending) {
      pending = resolvePlayable(id, target).catch((err) => ({ ok: false, error: err.message }));
      playInflight.set(id, pending);
      pending.finally(() => playInflight.delete(id));
    }
    // A provider sniff that takes longer than a few seconds should not keep the
    // visitor staring at "Preparing stream". The embed is mounted instead, and
    // the resolver keeps working in the background so the next play is direct.
    const found = await withDeadline(pending, PLAY_DEADLINE_MS);

    if (found.ok && found.kind === 'dash') {
      const session = createDashSession(id, found);
      let caching = false;
      if (cacheSlotAvailable()) {
        const job = startDashDownload({ id, title: meta.title ?? id, found, target });
        caching = ['resolving', 'downloading', 'finalizing'].includes(job.status);
      }
      return json(res, 200, {
        id,
        mode: 'live',
        caching,
        source: {
          provider: 'direct',
          label: 'injoy',
          kind: 'direct',
          container: 'dash',
          quality: found.video.height ? `${found.video.height}p` : 'auto',
          duration: found.duration,
          session,
        },
      });
    }

    // HLS is already muxed, so the player gets one segment list instead of two
    // tracks. The downloader saves the same playlist to disk in the background
    // when a cache slot is free, which is what flips this title to `local` later.
    if (found.ok && found.kind === 'hls') {
      const { session } = found;
      let caching = false;
      if (cacheSlotAvailable()) {
        const job = startDownload({
          id,
          title: meta.title ?? id,
          url: found.url,
          referer: found.referer ?? undefined,
          target,
        });
        caching = ['resolving', 'downloading', 'finalizing'].includes(job.status);
      }
      return json(res, 200, {
        id,
        mode: 'live',
        caching,
        source: {
          provider: 'direct',
          label: 'injoy',
          kind: 'direct',
          container: session.container,
          quality: session.quality ?? 'auto',
          duration: session.duration,
          session,
        },
      });
    }

    // A progressive file plays natively; the proxy exists only to add the
    // Referer the CDN wants and the CORS header the browser needs.
    if (found.ok && found.kind === 'progressive') {
      return json(res, 200, {
        id,
        mode: 'live',
        caching: false,
        source: {
          provider: 'direct',
          label: 'injoy',
          kind: 'direct',
          container: 'progressive',
          quality: 'auto',
          url: found.session.base,
        },
      });
    }

    // No direct stream: hand the player one embed, still without a picker.
    const data = await catalog.sources(id).catch(() => null);
    const fallback = (data?.sources ?? []).find((source) => source.kind === 'embed');
    if (!fallback) return fail(res, 502, found.error ?? 'no source available');
    return json(res, 200, { id, mode: 'embed', source: fallback });
  }

  // captions: one WebVTT track per language, converted from SubRip on this side
  const subsVttMatch = /^\/api\/subs\/(.+?)\/([a-z0-9-]+)\.vtt$/i.exec(pathname);
  if (subsVttMatch && method === 'GET') {
    const id = decodeURIComponent(subsVttMatch[1]);
    const lang = subsVttMatch[2].toLowerCase();
    const variant = searchParams.get('v');
    const requestedDuration = Number(searchParams.get('d'));
    const requestedFps = Number(searchParams.get('f'));
    const target = await captionTarget(
      id,
      Number.isFinite(requestedDuration) ? requestedDuration : null,
      Number.isFinite(requestedFps) ? requestedFps : null,
    );
    if (!target) return fail(res, 404, 'no captions for this title');
    const track = await subtitleVtt({ ...target, lang, variant });
    if (!track.ok) return fail(res, track.status ?? 502, track.error);
    res.writeHead(200, {
      'content-type': 'text/vtt; charset=utf-8',
      'cache-control': 'public, max-age=86400',
    });
    return res.end(track.body);
  }

  // the language list the player's caption menu is built from
  const subsMatch = /^\/api\/subs\/(.+)$/.exec(pathname);
  if (subsMatch && method === 'GET') {
    const id = decodeURIComponent(subsMatch[1]);
    const requestedDuration = Number(searchParams.get('d'));
    const requestedFps = Number(searchParams.get('f'));
    const target = await captionTarget(
      id,
      Number.isFinite(requestedDuration) ? requestedDuration : null,
      Number.isFinite(requestedFps) ? requestedFps : null,
    );
    if (!target) return json(res, 200, { id, imdbId: null, tracks: [] });
    const list = await subtitleTracks(target);
    return json(res, 200, { id, imdbId: list.imdbId ?? null, tracks: list.tracks ?? [] });
  }

  // a live HLS session re-opened on another rendition, for the quality menu
  const hlsVariantMatch = /^\/api\/hls\/variant\/([^/]+)\/(\d+)$/.exec(pathname);
  if (hlsVariantMatch && method === 'GET') {
    const [, sid, index] = hlsVariantMatch;
    const switched = await switchHlsVariant(sid, Number(index));
    if (!switched.ok) return fail(res, switched.status ?? 404, switched.error);
    const { ok: _ok, ...session } = switched;
    return json(res, 200, { session });
  }

  // live HLS segments, proxied and decrypted on the way through
  const hlsSegMatch = /^\/api\/hls\/seg\/([^/]+)\/(\d+)$/.exec(pathname);
  if (hlsSegMatch && method === 'GET') {
    const [, sid, index] = hlsSegMatch;
    const segment = await readHlsSegment(sid, Number(index));
    if (segment.error) return fail(res, segment.status ?? 502, segment.error);
    res.writeHead(200, {
      'content-type': segment.contentType,
      'content-length': segment.bytes.length,
      'cache-control': segment.cacheControl ?? 'private, max-age=300',
      ...SECURITY_HEADERS,
    });
    return res.end(segment.bytes);
  }

  // progressive file, Range pass-through so the element can seek
  const rawMatch = /^\/api\/raw\/([^/]+)$/.exec(pathname);
  if (rawMatch && (method === 'GET' || method === 'HEAD')) {
    const out = await readRaw(rawMatch[1], req.headers.range ?? null);
    if (out.error) return fail(res, out.status ?? 502, out.error);
    const headers = {
      'content-type': out.contentType,
      'content-length': out.bytes.length,
      'accept-ranges': out.acceptRanges,
      'cache-control': 'private, max-age=600',
      ...SECURITY_HEADERS,
    };
    if (out.contentRange) headers['content-range'] = out.contentRange;
    res.writeHead(out.status, headers);
    if (method === 'HEAD') return res.end();
    return res.end(out.bytes);
  }

  // a live DASH session re-opened on another video rendition
  const dashVariantMatch = /^\/api\/dash\/variant\/([^/]+)\/(\d+)$/.exec(pathname);
  if (dashVariantMatch && method === 'GET') {
    const [, sid, index] = dashVariantMatch;
    const switched = switchDashVariant(sid, Number(index));
    if (!switched.ok) return fail(res, switched.status ?? 404, switched.error);
    const { ok: _ok, ...session } = switched;
    return json(res, 200, { session });
  }

  // direct DASH: resolve an embed page to a manifest, then proxy its segments
  const dashSegMatch = /^\/api\/dash\/seg\/([^/]+)\/(video|audio)\/(\d+)$/.exec(pathname);
  if (dashSegMatch && method === 'GET') {
    const [, sid, track, index] = dashSegMatch;
    const segment = await readSegment(sid, track, Number(index));
    if (segment.error) return fail(res, segment.status ?? 502, segment.error);
    res.writeHead(200, {
      'content-type': segment.contentType,
      'content-length': segment.bytes.length,
      'cache-control': segment.cacheControl ?? 'private, max-age=300',
      ...SECURITY_HEADERS,
    });
    return res.end(segment.bytes);
  }

  const dashMatch = /^\/api\/dash\/(.+)$/.exec(pathname);
  if (dashMatch && method === 'GET') {
    const id = decodeURIComponent(dashMatch[1]);
    const meta = await catalog.detail(id).catch(() => null);
    const target = streamTarget(id, meta);
    if (!target) return fail(res, 404, 'title not found');
    const session = await openDashSession({ id, ...target });
    if (!session.ok) return fail(res, 502, session.error ?? 'no direct stream');
    return json(res, 200, { id, ...session });
  }

  // downloaded DASH segments, straight off the disk
  const localSegMatch = /^\/api\/local-dash\/([^/]+)\/seg\/(video|audio)\/(\d+)$/.exec(pathname);
  if (localSegMatch && method === 'GET') {
    const [, rawId, track, index] = localSegMatch;
    const bytes = await readDashSegment(decodeURIComponent(rawId), track, Number(index));
    if (!bytes) return fail(res, 404, 'segment not on disk');
    res.writeHead(200, {
      'content-type': 'video/iso.segment',
      'content-length': bytes.length,
      'cache-control': 'public, max-age=31536000, immutable',
      ...SECURITY_HEADERS,
    });
    return res.end(bytes);
  }

  // downloaded HLS segments: one file per playlist entry, index 0 = init on fMP4
  const localHlsMatch = /^\/api\/local-hls\/([^/]+)\/(\d+)$/.exec(pathname);
  if (localHlsMatch && method === 'GET') {
    const [, rawId, index] = localHlsMatch;
    const segment = await readLocalHlsSegment(decodeURIComponent(rawId), Number(index));
    if (!segment) return fail(res, 404, 'segment not on disk');
    res.writeHead(200, {
      'content-type': segment.contentType,
      'content-length': segment.bytes.length,
      'cache-control': 'public, max-age=31536000, immutable',
      ...SECURITY_HEADERS,
    });
    return res.end(segment.bytes);
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
      // A finished download changes the play payload; do not let a cached
      // source list hide the local copy.
      if (media) cache.drop(`sources:${id}`);
      return json(res, 200, { id, job, media });
    }

    if (method === 'DELETE') {
      cancelDownload(id);
      const removed = await removeMedia(id);
      cache.drop(`sources:${id}`);
      return json(res, 200, { removed });
    }

    if (method === 'POST') {
      const body = await readBody(req);
      const title = body?.title ?? id;

      if (body?.url) {
        const job = startDownload({ id, title, url: body.url, referer: body.referer });
        return json(res, 202, { id, job });
      }

      // No URL supplied: the site resolves and caches the title itself. The
      // visitor never sees this route; it exists for the library view and for
      // a manual re-cache from the admin surface.
      const meta = await catalog.detail(baseIdFor(id)).catch(() => null);
      if (!meta) return fail(res, 404, 'title not found');
      const target = streamTarget(id, meta);
      if (!target) return fail(res, 404, 'title not found');

      const job = startDownload({ id, title: meta.title ?? title, target });
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
