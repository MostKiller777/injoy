/**
 * VidSrc PM direct resolver.
 *
 * The embed page is a single-page app, but the player it mounts talks to a
 * plain JSON endpoint: `/api/vidora/v1/movie/{tmdb}` (or
 * `/v1/tv/{tmdb}/{season}/{episode}`) with one `source` key at a time and an
 * `x-player-key` header. The answer carries the manifest URL verbatim.
 *
 * That means no browser and no netlog: a title resolves in about a second,
 * anywhere, including a 512 MB container with no Chrome installed. The manifests
 * are HLS playlists whose segments are served as image/jpeg; the bytes are
 * MPEG-TS, which the HLS proxy re-serves as video/mp2t.
 */

const BASE = 'https://vidsrc.pm';
const REFERER = `${BASE}/`;

// Fallback key from the current player bundle. It is refreshed at runtime when
// the endpoint answers 401/403, so a rotation costs one extra request.
const FALLBACK_PLAYER_KEY = 'f3b72e73c80c9a996574379798703796a1936efa3516a7105cb0e43048b46b5a';

// Source keys the site offers, in the order the player picks them. The first
// entry round-trips through a broken proxy often enough to skip it.
const SOURCES = ['vjej', 'fq1k', 'nzv4', 'w7dn', 'b4tz'];

const ATTEMPT_TIMEOUT_MS = 9_000;
const KEY_TTL_MS = 60 * 60_000;

let playerKey = FALLBACK_PLAYER_KEY;
let playerKeyAt = 0;

/** Pull `x-player-key` out of the site's main bundle when the cached one dies. */
async function refreshPlayerKey() {
  if (Date.now() - playerKeyAt < 60_000 && playerKey !== FALLBACK_PLAYER_KEY) return playerKey;
  playerKeyAt = Date.now();
  try {
    const page = await fetch(`${BASE}/`, { headers: { 'user-agent': UA } }).then((r) => r.text());
    const bundle = /src="(\/assets\/main-[^"]+\.js)"/.exec(page)?.[1];
    if (!bundle) return playerKey;
    const js = await fetch(`${BASE}${bundle}`, { headers: { 'user-agent': UA } }).then((r) => r.text());
    const found = /x-player-key":([a-z0-9]+)/i.exec(js)?.[1] ?? /`([a-f0-9]{64})`,\w+=`[a-f0-9]{32}`/.exec(js)?.[1];
    if (found) playerKey = found;
  } catch {
    // keep the previous key
  }
  return playerKey;
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

import { manifestAudioLanguage } from './tslang.js';

async function ask(path, source, key) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ATTEMPT_TIMEOUT_MS);
  timer.unref?.();
  try {
    const res = await fetch(`${BASE}/api/vidora${path}?source=${source}`, {
      signal: controller.signal,
      headers: {
        'user-agent': UA,
        accept: 'application/json',
        referer: REFERER,
        origin: BASE,
        'x-player-key': key,
      },
    });
    if (res.status === 401 || res.status === 403) return { retryKey: true };
    if (!res.ok) return null;
    const body = await res.json().catch(() => null);
    const url = body?.sources?.[0]?.url;
    if (!body?.result || !url) return null;
    // Some source keys wrap the manifest in a Cloudflare worker that only
    // answers a browser holding its clearance cookie; a server gets 403. Those
    // are skipped so the next key gets a chance at a direct host.
    if (/\/proxy\?url=/i.test(url)) return null;
    return {
      url,
      // The endpoint names a playlist, not a container: the extension decides
      // whether the player opens it as HLS or DASH.
      type: /\.mpd(\?|$)/i.test(url) ? 'dash' : 'hls',
      referer: REFERER,
      page: `${BASE}/embed/${path.startsWith('/v1/tv') ? 'tv' : 'movie'}`,
      title: body.title ?? null,
      year: body.year ?? null,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve a film or episode to a manifest URL.
 *
 * Returns `{ url, type, referer, page }` on a hit, `{ error }` when every
 * source key declined. Callers treat a miss as "nothing to see here" and keep
 * walking their own provider list.
 */
const LANG_CACHE = new Map();

/** Language of a manifest, remembered per URL so a replay costs nothing. */
async function languageOf(hit) {
  const key = hit.url;
  const cached = LANG_CACHE.get(key);
  if (cached !== undefined) return cached;
  const lang = await manifestAudioLanguage(hit.url, hit.referer).catch(() => null);
  if (LANG_CACHE.size > 400) LANG_CACHE.clear();
  LANG_CACHE.set(key, lang);
  return lang;
}

/**
 * Pick the candidate whose default audio is English.
 *
 * Each source key is a different encode of the same film, and plenty of them are
 * dual-audio releases whose first PID is a dub. Silence is worse than a slower
 * start, so each candidate's first segment is read and the PMT decides; an
 * unreadable candidate counts as acceptable rather than being skipped.
 *
 * The first candidate is probed alone because it is usually the answer; only
 * when it is not English are the rest read at once.
 */
async function preferEnglish(hits, prefer) {
  // An explicit key from the viewer is a decision, not a suggestion.
  if (prefer) return hits[0];

  const first = hits[0];
  const firstLang = await languageOf(first);
  if (!firstLang || firstLang === 'eng' || firstLang === 'en' || firstLang === 'und') return first;

  const rest = hits.slice(1);
  const langs = await Promise.all(rest.map((hit) => languageOf(hit)));
  for (let at = 0; at < rest.length; at += 1) {
    const lang = langs[at];
    if (!lang || lang === 'eng' || lang === 'en' || lang === 'und') return rest[at];
  }
  return first;
}

export async function vidoraStream({ tmdbId, season = null, episode = null, prefer = null } = {}) {
  const id = Number(tmdbId);
  if (!Number.isFinite(id) || id <= 0) return { error: 'no tmdb id' };

  const path = season && episode
    ? `/v1/tv/${id}/${Number(season)}/${Number(episode)}`
    : `/v1/movie/${id}`;

  // `prefer` is the viewer asking for a different audio mix: the providers each
  // carry their own encode, so the same film can be a dub on one key and the
  // original on another. Rotation keeps that choice first without losing the
  // others as fallbacks.
  const order = prefer && SOURCES.includes(prefer)
    ? [prefer, ...SOURCES.filter((key) => key !== prefer)]
    : SOURCES;

  let key = playerKey;

  // The keys are independent requests, so they run together: five serial
  // eight-second timeouts turned a missing episode into a forty-second wait,
  // and the player fell back to an embed before the answer arrived.
  const attempts = await Promise.all(order.map((source) => ask(path, source, key)));

  const tried = [];
  let staleKey = false;
  const hits = [];
  for (let at = 0; at < order.length; at += 1) {
    const hit = attempts[at];
    if (hit?.retryKey) staleKey = true;
    tried.push({ source: order[at], url: hit?.url ?? null });
    if (hit?.url) hits.push({ ...hit, source: order[at] });
  }

  if (hits.length) return { ...(await preferEnglish(hits, prefer)), tried };

  // One rotation is enough: refresh once and repeat the whole set.
  if (staleKey) {
    key = await refreshPlayerKey();
    const retry = await Promise.all(order.map((source) => ask(path, source, key)));
    for (let at = 0; at < order.length; at += 1) {
      const hit = retry[at];
      if (hit?.url) return { ...hit, tried: [...tried, { source: order[at], url: hit.url }] };
    }
  }

  return { error: 'vidora had no playable source', tried };
}

export function vidoraKeyAge() {
  return Date.now() - playerKeyAt < KEY_TTL_MS ? 'fresh' : 'stale';
}
