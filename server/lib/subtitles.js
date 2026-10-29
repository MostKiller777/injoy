import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { dataPath } from './paths.js';

/**
 * Captions.
 *
 * Neither provider ships a text track: the DASH manifests carry video and audio
 * adaptation sets only, and the HLS playlists have no `EXT-X-MEDIA` at all. So
 * captions come from the OpenSubtitles index behind Stremio's public addon,
 * which needs no key and answers with every language the film has.
 *
 * Two things happen here. A title is mapped to an IMDb id — series already know
 * theirs from the frozen map, films are matched once by title and year and the
 * answer is kept forever. Then the addon's list is collapsed to one track per
 * language and each track is fetched, converted from SubRip to WebVTT, and
 * cached on disk. A browser will not play `.srt` through a `<track>`; it plays
 * WebVTT and nothing else.
 *
 * Layout:
 *   <data>/subs/imdb.json               id → imdb id, permanent
 *   <data>/subs/<id>/<lang>.vtt         converted track
 */

const ADDON = 'https://opensubtitles-v3.strem.io';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const SUGGEST = 'https://v2.sg.media-imdb.com/suggestion/x';
const TRACK_TTL = 6 * 60 * 60_000;
const LIST_TIMEOUT = 15_000;
const FILE_TIMEOUT = 25_000;
const MAX_BYTES = 6 * 1024 * 1024;

const subsRoot = () => dataPath('subs');
const imdbIndexPath = () => join(subsRoot(), 'imdb.json');
const titleDir = (id) => join(subsRoot(), String(id).replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120));

/** ISO 639-2/B (what the addon returns) → ISO 639-1 (what `srclang` wants). */
const ALPHA3 = {
  ara: 'ar', arm: 'hy', baq: 'eu', ben: 'bn', bos: 'bs', bre: 'br', bul: 'bg',
  bur: 'my', cat: 'ca', chi: 'zh', cze: 'cs', dan: 'da', dut: 'nl', eng: 'en',
  epo: 'eo', est: 'et', fin: 'fi', fre: 'fr', geo: 'ka', ger: 'de', gla: 'gd',
  gle: 'ga', glg: 'gl', gre: 'el', heb: 'he', hin: 'hi', hrv: 'hr', hun: 'hu',
  ice: 'is', ind: 'id', ita: 'it', jpn: 'ja', kan: 'kn', kaz: 'kk', khm: 'km',
  kor: 'ko', lav: 'lv', lit: 'lt', mac: 'mk', mal: 'ml', may: 'ms', mni: 'mni',
  mon: 'mn', nor: 'no', per: 'fa', pol: 'pl', por: 'pt', rum: 'ro', rus: 'ru',
  scc: 'sr', srp: 'sr', sin: 'si', slo: 'sk', slv: 'sl', spa: 'es', swe: 'sv',
  tam: 'ta', tel: 'te', tgl: 'tl', tha: 'th', tur: 'tr', ukr: 'uk', urd: 'ur',
  vie: 'vi', wel: 'cy', yor: 'yo', zul: 'zu', alb: 'sq', amh: 'am', aze: 'az',
  bel: 'be', fil: 'fil', guj: 'gu', ksw: 'ks', kur: 'ku', lao: 'lo', mar: 'mr',
  nep: 'ne', pan: 'pa', pob: 'pt-BR', som: 'so', swa: 'sw', uzb: 'uz',
};

/** English name for a subtitle language, from the 639-2 code the addon sends. */
export function languageName(code) {
  const alpha2 = ALPHA3[code] ?? (code.length === 2 ? code : null);
  if (!alpha2) return code.toUpperCase();
  try {
    const names = new Intl.DisplayNames(['en'], { type: 'language' });
    const name = names.of(alpha2 === 'pt-BR' ? 'pt' : alpha2);
    if (!name || name === alpha2) return code.toUpperCase();
    return alpha2 === 'pt-BR' ? `${name} (BR)` : name;
  } catch {
    return alpha2.toUpperCase();
  }
}

/* --------------------------------- imdb --------------------------------- */

let imdbCache = null;

async function loadImdb() {
  if (imdbCache) return imdbCache;
  try {
    imdbCache = JSON.parse(await readFile(imdbIndexPath(), 'utf8'));
  } catch {
    imdbCache = {};
  }
  return imdbCache;
}

async function saveImdb(map) {
  imdbCache = map;
  try {
    await mkdir(subsRoot(), { recursive: true });
    await writeFile(imdbIndexPath(), JSON.stringify(map, null, 0));
  } catch {
    // a read-only data dir still serves captions; the map just is not kept
  }
}

const normalize = (value) => String(value ?? '')
  .toLowerCase()
  .replace(/[^a-z0-9 ]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

/**
 * Match a film to its IMDb id through the public suggestion endpoint.
 *
 * The query is the title, and the answer is scored: exact title first, then
 * same year, then "feature" over anything else. A film whose title and year
 * both hit is right essentially always; a miss is remembered as a miss so the
 * next play does not repeat the search.
 */
async function lookupImdb(title, year) {
  if (!title) return null;
  const query = normalize(title);
  const url = `${SUGGEST}/${encodeURIComponent(query.split(' ').slice(0, 6).join(' '))}.json`;
  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'application/json' },
    signal: AbortSignal.timeout(LIST_TIMEOUT),
  });
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  const hits = Array.isArray(data?.d) ? data.d : [];

  let best = null;
  let bestScore = -1;
  for (const hit of hits) {
    if (!/^tt\d+$/.test(String(hit.id ?? ''))) continue;
    const sameTitle = normalize(hit.l) === query;
    const sameYear = Number(year) > 0 && Number(hit.y) === Number(year);
    const feature = hit.q === 'feature' || hit.q === 'video' || hit.q === 'TV movie';
    const score = (sameTitle ? 100 : 0) + (sameYear ? 50 : 0) + (feature ? 10 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = hit.id;
    }
  }
  // A loose title match with the wrong year is a different film; refuse it
  // rather than serve another movie's captions.
  return bestScore >= 60 ? best : null;
}

/* -------------------------------- listing -------------------------------- */

const trackCache = new Map();

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'application/json' },
    signal: AbortSignal.timeout(LIST_TIMEOUT),
  });
  if (!res.ok) throw new Error(`subtitle index answered ${res.status}`);
  return res.json();
}

/**
 * Every language the index has for this title, one track each.
 *
 * Returns `{ ok, imdbId, tracks: [{ lang, code, label, url }] }`. `url` is a
 * same-origin WebVTT endpoint — the browser never reaches the subtitle CDN, and
 * the SubRip → WebVTT conversion stays on this side.
 */
export async function subtitleTracks({ id, title, year, imdbId = null, season = null, episode = null }) {
  const cached = trackCache.get(id);
  if (cached && Date.now() - cached.at < TRACK_TTL) return cached.value;

  let imdb = imdbId;
  if (!imdb) {
    const map = await loadImdb();
    imdb = map[id] ?? null;
    if (imdb === undefined || imdb === null) {
      imdb = await lookupImdb(title, year).catch(() => null);
      map[id] = imdb;
      await saveImdb(map);
    }
  }
  if (!imdb) {
    const value = { ok: true, imdbId: null, tracks: [] };
    trackCache.set(id, { at: Date.now(), value });
    return value;
  }

  const path = season
    ? `${ADDON}/subtitles/series/${imdb}:${season}:${episode ?? 1}.json`
    : `${ADDON}/subtitles/movie/${imdb}.json`;

  let data;
  try {
    data = await fetchJson(path);
  } catch (err) {
    return { ok: false, error: err.message, imdbId: imdb, tracks: [] };
  }

  const raw = Array.isArray(data?.subtitles) ? data.subtitles : [];
  const byLang = new Map();
  for (const entry of raw) {
    const lang = String(entry.lang ?? '').toLowerCase();
    if (!lang || !entry.url) continue;
    const score = (entry.SubEncoding === 'UTF-8' ? 1000 : 0)
      + (Number(entry.g) || 0)
      + (/bluray|web-?dl|webrip/i.test(entry.releaseFormat ?? '') ? 40 : 0);
    const held = byLang.get(lang);
    if (!held || score > held.score) {
      byLang.set(lang, { score, entry, lang });
    }
  }

  const tracks = [...byLang.values()]
    .map(({ entry, lang }) => ({
      lang,
      code: ALPHA3[lang] ?? (lang.length === 2 ? lang : lang.slice(0, 2)),
      label: languageName(lang),
      url: `/api/subs/${encodeURIComponent(id)}/${encodeURIComponent(lang)}.vtt`,
      source: entry.url,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));

  const value = { ok: true, imdbId: imdb, tracks };
  trackCache.set(id, { at: Date.now(), value });
  return value;
}

/* ------------------------------- conversion ------------------------------- */

const timestamp = /\b(\d{1,2}:\d{2}:\d{2}),(\d{1,3})\b/g;

/**
 * SubRip → WebVTT.
 *
 * Three differences matter and nothing else does: a `WEBVTT` header, a dot
 * instead of a comma in every timestamp, and no bare index lines. The rest of
 * the file is already valid cue text, so it is passed through untouched apart
 * from the ASS positioning overrides and font tags a browser will not render.
 */
export function srtToVtt(input) {
  const text = String(input)
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\{\\an?\d+\}/gi, '')
    .replace(/<\/?font[^>]*>/gi, '')
    .replace(/\\h/g, ' ')
    .replace(timestamp, (_, time, ms) => `${time}.${ms.padEnd(3, '0')}`);

  const lines = text.split('\n');
  const out = [];
  for (const line of lines) {
    // A cue index is a lone number on its own line. WebVTT would read it as a
    // cue identifier, which is legal but confuses nothing; dropping it keeps
    // the file tidy and avoids a stray digit rendering when a blank line is
    // missing between cues.
    if (/^\s*\d+\s*$/.test(line)) continue;
    out.push(line);
  }

  const body = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return `WEBVTT\n\n${body}\n`;
}

/** Decode a subtitle file: the addon usually hands over UTF-8, sometimes not. */
function decode(buffer) {
  const utf8 = buffer.toString('utf8');
  if (!utf8.includes('\uFFFD')) return utf8;
  return buffer.toString('latin1');
}

/**
 * One track as WebVTT, converted once and kept on disk.
 *
 * The list is re-read from the index so a stale `source` URL is not reused
 * after the process restarts; the converted file is the cache that matters.
 */
export async function subtitleVtt({ id, lang, title, year, imdbId = null, season = null, episode = null }) {
  const file = join(titleDir(id), `${String(lang).replace(/[^a-z0-9-]/gi, '')}.vtt`);
  try {
    return { ok: true, body: await readFile(file, 'utf8') };
  } catch {
    // not converted yet
  }

  const list = await subtitleTracks({ id, title, year, imdbId, season, episode });
  const track = list.tracks.find((entry) => entry.lang === lang);
  if (!track) return { ok: false, status: 404, error: 'no such language' };

  let res;
  try {
    res = await fetch(track.source, {
      headers: { 'user-agent': UA },
      signal: AbortSignal.timeout(FILE_TIMEOUT),
    });
  } catch (err) {
    return { ok: false, status: 502, error: err.message };
  }
  if (!res.ok) return { ok: false, status: 502, error: `subtitle file answered ${res.status}` };

  const buffer = Buffer.from(await res.arrayBuffer());
  if (!buffer.length) return { ok: false, status: 502, error: 'subtitle file is empty' };
  if (buffer.length > MAX_BYTES) return { ok: false, status: 502, error: 'subtitle file is implausibly large' };

  const raw = decode(buffer);
  const body = /^WEBVTT/.test(raw.trimStart()) ? raw : srtToVtt(raw);

  try {
    await mkdir(titleDir(id), { recursive: true });
    await writeFile(file, body, 'utf8');
  } catch {
    // still serve it; the next request converts again
  }
  return { ok: true, body };
}
