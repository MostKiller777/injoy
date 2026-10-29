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
const CACHE_VERSION = 'v3';

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'application/json' },
    signal: AbortSignal.timeout(LIST_TIMEOUT),
  });
  if (!res.ok) throw new Error(`subtitle index answered ${res.status}`);
  return res.json();
}

/**
 * How good a candidate is likely to be, before anyone has watched it.
 *
 * The index lists every upload for a language, and they are not equivalent:
 * a release-group file timed to the retail Blu-ray is not the same as a cam
 * rip's, a split-CD file starts its clock twice, and a legacy code page loses
 * accented characters. Ranking happens on the server so the player gets the
 * best track by default instead of whichever one the index happened to return
 * first.
 */
function scoreCandidate(entry) {
  const encoding = String(entry.SubEncoding ?? '').toUpperCase();
  const release = String(entry.movieReleaseName ?? '');
  const file = String(entry.subtitleFileName ?? '');
  const name = `${release} ${file}`;
  const fps = Number(entry.fpsMilli) || 0;

  let score = 0;
  if (encoding === 'UTF-8') score += 400;
  else if (encoding === 'ASCII') score += 320;
  else score += 160;
  score += Math.min(140, Number(entry.g) || 0);
  // A declared frame rate means the uploader timed it to a specific master, so
  // the cues were placed against a real reference instead of eyeballed.
  if (fps) score += 70;
  if (/bluray|blu-ray|bdrip|web-?dl|webrip|remux/i.test(name)) score += 35;
  // Two-part rips carry a second clock for the second half. They desync by
  // minutes on a single-file copy, which no amount of nudging repairs.
  if (/\bcd\s?[12]\b|part\.?\s?[12]\b|disc\s?[12]\b/i.test(name)) score -= 90;
  if (/\bcam\b|\bhd-?cam\b|\bts\b|telesync|screener|\bscr\b/i.test(name)) score -= 60;
  if (Number(entry.season) > 0 || Number(entry.episode) > 0) score += 20;
  return score;
}

const cleanRelease = (entry) => String(entry.movieReleaseName ?? '').trim()
  || String(entry.subtitleFileName ?? '').replace(/\.[a-z0-9]{2,4}$/i, '').trim()
  || null;

const variantUrl = (id, lang, candidateId, duration = null) => {
  const params = new URLSearchParams();
  if (candidateId) params.set('v', candidateId);
  if (Number.isFinite(duration) && duration > 0) params.set('d', String(Math.round(duration)));
  const query = params.toString();
  return `/api/subs/${encodeURIComponent(id)}/${encodeURIComponent(lang)}.vtt${query ? `?${query}` : ''}`;
};

/**
 * Every language the index has for this title.
 *
 * Each language keeps its ranked candidates, not just the winner: the player
 * lists them so a copy that disagrees with the top pick can be swapped for a
 * release that matches. `url` is a same-origin WebVTT endpoint — the browser
 * never reaches the subtitle CDN, and the SubRip → WebVTT conversion stays on
 * this side.
 *
 * Returns `{ ok, imdbId, tracks: [{ lang, code, label, url, release, fps,
 * downloads, variants: [...] }] }`.
 */
export async function subtitleTracks({ id, title, year, imdbId = null, season = null, episode = null, duration = null }) {
  const durationKey = Number.isFinite(duration) && duration > 0 ? Math.round(duration) : 'auto';
  const cacheKey = `${id}:${durationKey}`;
  const cached = trackCache.get(cacheKey);
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
    trackCache.set(cacheKey, { at: Date.now(), value });
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
    const scored = { score: scoreCandidate(entry), entry, lang };
    const held = byLang.get(lang);
    if (!held) byLang.set(lang, [scored]);
    else held.push(scored);
  }

  const tracks = [...byLang.entries()]
    .map(([lang, list]) => {
      list.sort((a, b) => b.score - a.score || (Number(b.entry.g) || 0) - (Number(a.entry.g) || 0));
      const variants = list.slice(0, 4).map(({ entry, score }, index) => ({
        id: String(entry.id ?? index),
        url: variantUrl(id, lang, index === 0 ? null : String(entry.id ?? index), duration),
        release: cleanRelease(entry),
        fps: Number(entry.fpsMilli) ? Number(entry.fpsMilli) / 1000 : null,
        downloads: Number(entry.g) || 0,
        score,
        source: entry.url,
      }));
      const best = variants[0];
      return {
        lang,
        code: ALPHA3[lang] ?? (lang.length === 2 ? lang : lang.slice(0, 2)),
        label: languageName(lang),
        url: best.url,
        source: best.source,
        release: best.release,
        fps: best.fps,
        downloads: best.downloads,
        variants,
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label));

  const value = { ok: true, imdbId: imdb, tracks };
  trackCache.set(cacheKey, { at: Date.now(), value });
  return value;
}

/* ------------------------------- conversion ------------------------------- */

const TIMING_LINE = /(\d{1,2}:\d{2}(?::\d{2})?[,.]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}(?::\d{2})?[,.]\d{1,3})/;

function timestampSeconds(stamp) {
  const normalized = String(stamp).replace(',', '.');
  const parts = normalized.split(':');
  if (parts.length === 2) {
    const [minutes, seconds] = parts.map(Number);
    return minutes * 60 + seconds;
  }
  if (parts.length === 3) {
    const [hours, minutes, seconds] = parts.map(Number);
    return hours * 3600 + minutes * 60 + seconds;
  }
  return NaN;
}

const secondsToStamp = (value) => {
  const milliseconds = Math.max(0, Math.round(Number(value) * 1000));
  const h = Math.floor(milliseconds / 3_600_000);
  const m = Math.floor((milliseconds % 3_600_000) / 60_000);
  const s = Math.floor((milliseconds % 60_000) / 1000);
  const ms = milliseconds % 1000;
  const pad = (n, width = 2) => String(n).padStart(width, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(ms, 3)}`;
};

/**
 * Cue text a browser will actually render.
 *
 * SubRip files carry ASS override blocks (`{\an8}`, `{\i1}`, `{\pos(..)}`) and
 * font tags. WebVTT understands `<i>`, `<b>` and `<u>` and nothing else, so the
 * override blocks are removed outright and the font tags are unwrapped — the
 * words stay, the styling does not.
 */
function cleanCueText(text) {
  return text
    .replace(/\{[^}]*\}/g, '')
    .replace(/<\/?font[^>]*>/gi, '')
    .replace(/\\N/gi, '\n')
    .replace(/\\h/g, ' ')
    .split('\n')
    .map((line) => line.replace(/\s+$/g, '').replace(/^[ \t]+/g, ''))
    .filter((line) => line.length)
    .join('\n')
    .trim();
}

/**
 * Parse SubRip into timed cues.
 *
 * Blocks are split on blank lines, and a block's timings are the first line that
 * matches the `start --> end` shape — index lines, stray blanks and missing
 * separators are all tolerated, because a real index is full of files that are
 * *almost* valid.
 */
export function parseSrt(input) {
  const text = String(input).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  const cues = [];
  let current = null;

  const flush = () => {
    if (!current) return;
    const body = cleanCueText(current.lines.join('\n'));
    if (body && current.end > current.start) {
      cues.push({ start: current.start, end: current.end, text: body });
    }
    current = null;
  };

  for (const line of lines) {
    const match = TIMING_LINE.exec(line);
    if (match) {
      flush();
      current = {
        start: timestampSeconds(match[1]),
        end: timestampSeconds(match[2]),
        lines: [],
      };
      continue;
    }
    if (!current) continue;
    if (!line.trim()) {
      flush();
      continue;
    }
    // SRT indexes are not cue text. A malformed file can put one immediately
    // before a timing line; ignore it without requiring blank separators.
    if (!current.lines.length && /^\s*\d+\s*$/.test(line)) continue;
    current.lines.push(line);
  }
  flush();
  return cues;
}

/** WebVTT uses the same arrow but also permits mm:ss.mmm timestamps. */
export function parseVtt(input) {
  const text = String(input).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  const cues = [];
  let current = null;
  let ignoredBlock = false;

  const flush = () => {
    if (!current) return;
    const body = cleanCueText(current.lines.join('\n'));
    if (body && current.end > current.start) {
      cues.push({ start: current.start, end: current.end, text: body });
    }
    current = null;
  };

  for (const line of lines) {
    if (/^(NOTE|STYLE|REGION)(?:\s|$)/i.test(line)) {
      flush();
      ignoredBlock = true;
      continue;
    }
    if (ignoredBlock) {
      if (!line.trim()) ignoredBlock = false;
      continue;
    }
    const match = TIMING_LINE.exec(line);
    if (match) {
      flush();
      current = {
        start: timestampSeconds(match[1]),
        end: timestampSeconds(match[2]),
        lines: [],
      };
      continue;
    }
    if (!current) continue;
    if (!line.trim()) {
      flush();
      continue;
    }
    current.lines.push(line);
  }
  flush();
  return cues;
}

/**
 * Timing repair, applied to every track before it is served.
 *
 * Real subtitle files overlap, flash, and repeat. A cue that starts before the
 * previous one ends renders two lines on top of each other; a cue under half a
 * second is gone before the eye lands on it; a duplicated cue flickers. None of
 * that is the viewer's problem to fix, and none of it is fixable by nudging the
 * whole track — so it is fixed once, here.
 *
 * Rules, in order:
 *  - sorted by start time, then by end time
 *  - cues under 120 ms or empty are dropped
 *  - consecutive cues with identical text closer than 150 ms apart are merged
 *  - an overlap longer than 60 ms trims the earlier cue, never the later one
 *  - a cue shorter than 800 ms grows into the gap before the next one, capped
 *    at 5 s so a stray one-word line does not sit on screen for minutes
 */
export function normalizeCues(input) {
  const cues = input
    .filter((cue) => cue.text && cue.end - cue.start > 0.12)
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const merged = [];
  for (const cue of cues) {
    const previous = merged[merged.length - 1];
    if (previous && previous.text === cue.text && cue.start - previous.end < 0.15) {
      previous.end = Math.max(previous.end, cue.end);
      continue;
    }
    merged.push({ ...cue });
  }

  for (let i = 0; i < merged.length; i += 1) {
    const cue = merged[i];
    const next = merged[i + 1];
    if (next && cue.end - next.start > 0.06) {
      cue.end = Math.max(cue.start + 0.4, next.start - 0.02);
    }
    if (cue.end - cue.start < 0.8) {
      const ceiling = next ? next.start - 0.02 : cue.start + 5;
      cue.end = Math.min(cue.start + 5, Math.max(cue.end, Math.min(ceiling, cue.start + 0.8)));
    }
  }

  return merged.filter((cue) => cue.end > cue.start);
}

/** Cues → WebVTT. */
export function cuesToVtt(cues) {
  const body = cues
    .map((cue) => `${secondsToStamp(cue.start)} --> ${secondsToStamp(cue.end)}\n${cue.text}`)
    .join('\n\n');
  return `WEBVTT\n\n${body}\n`;
}

function normalizeCaptionBody(raw) {
  const text = String(raw).replace(/^\uFEFF/, '');
  const parsed = /^\s*WEBVTT(?:\s|$)/i.test(text)
    ? parseVtt(text)
    : parseSrt(text);
  const cues = normalizeCues(parsed);
  return {
    body: cuesToVtt(cues),
    cues,
    first: cues[0]?.start ?? null,
    last: cues.at(-1)?.end ?? null,
  };
}

/**
 * SubRip → WebVTT, with the timing repaired on the way through.
 *
 * Kept as a single exported entry point because every caption path funnels
 * through it: index files are SubRip, and a browser will not play `.srt`
 * through a `<track>`.
 */
export function srtToVtt(input) {
  return normalizeCaptionBody(input).body;
}

/** Decode a subtitle file: the addon usually hands over UTF-8, sometimes not. */
function decode(buffer) {
  const utf8 = buffer.toString('utf8');
  if (!utf8.includes('\uFFFD')) return utf8;
  return buffer.toString('latin1');
}

const sanitizeLang = (lang) => String(lang).replace(/[^a-z0-9-]/gi, '');
const sanitizeVariant = (variant) => String(variant ?? '').replace(/[^a-zA-Z0-9._-]+/g, '').slice(0, 40);

async function fetchSubtitle(url) {
  const res = await fetch(url, {
    headers: { 'user-agent': UA },
    signal: AbortSignal.timeout(FILE_TIMEOUT),
  });
  if (!res.ok) throw Object.assign(new Error(`subtitle file answered ${res.status}`), { status: 502 });
  const buffer = Buffer.from(await res.arrayBuffer());
  if (!buffer.length) throw Object.assign(new Error('subtitle file is empty'), { status: 502 });
  if (buffer.length > MAX_BYTES) throw Object.assign(new Error('subtitle file is implausibly large'), { status: 502 });
  return normalizeCaptionBody(decode(buffer));
}

/**
 * Pick the upload whose final dialogue is closest to the actual media clock.
 *
 * Subtitle files usually stop before the final credits, so comparing the last
 * cue with the absolute end would punish the right file. A 2.5% trailing
 * margin, capped at three minutes, is a stable estimate across films and
 * episodes. The player supplies the exact stream duration; catalog runtime is
 * only the fallback hint.
 */
function timingDistance(lastCue, duration) {
  if (!Number.isFinite(lastCue) || !(duration > 0)) return Infinity;
  const tail = Math.min(180, Math.max(20, duration * 0.025));
  return Math.abs(lastCue - (duration - tail));
}

/**
 * One track as WebVTT, converted once and kept on disk.
 *
 * `variant` names a specific upload for the language; without one the ranked
 * best is used. The list is re-read from the index so a stale `source` URL is
 * not reused after the process restarts; the converted file is the cache that
 * matters.
 */
export async function subtitleVtt({ id, lang, title, year, imdbId = null, season = null, episode = null, duration = null, variant = null }) {
  const durationKey = Number.isFinite(duration) && duration > 0 ? `d${Math.round(duration)}` : 'auto';
  const suffix = variant ? `__${sanitizeVariant(variant)}` : '';
  const file = join(titleDir(id), `${sanitizeLang(lang)}.${CACHE_VERSION}.${durationKey}${suffix}.vtt`);
  try {
    return { ok: true, body: await readFile(file, 'utf8') };
  } catch {
    // not converted yet
  }

  const list = await subtitleTracks({ id, title, year, imdbId, season, episode, duration });
  const track = list.tracks.find((entry) => entry.lang === lang);
  if (!track) return { ok: false, status: 404, error: 'no such language' };

  const candidates = variant
    ? [(track.variants ?? []).find((entry) => entry.id === String(variant))].filter(Boolean)
    : (track.variants?.length ? track.variants : [track]);
  const loaded = (await Promise.allSettled(candidates.map(async (candidate) => ({
    candidate,
    converted: await fetchSubtitle(candidate.source),
  })))).flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
  if (!loaded.length) return { ok: false, status: 502, error: 'all subtitle files failed to download' };

  loaded.sort((a, b) => {
    const byTiming = timingDistance(a.converted.last, duration) - timingDistance(b.converted.last, duration);
    return byTiming || b.candidate.score - a.candidate.score;
  });
  const winner = loaded[0].converted;
  const body = winner.body;

  try {
    await mkdir(titleDir(id), { recursive: true });
    await writeFile(file, body, 'utf8');
  } catch {
    // still serve it; the next request converts again
  }
  return { ok: true, body };
}
