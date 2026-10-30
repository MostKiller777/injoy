import { randomUUID } from 'node:crypto';

import { resolveStream } from './resolver.js';

/**
 * Direct-stream sessions.
 *
 * The working embed providers answer with a DASH manifest whose video and audio
 * ride separate tracks. Nothing on this box can mux them, but a browser does not
 * need a muxer: MSE takes one SourceBuffer per track and plays them in sync off
 * their own timestamps. This module turns a manifest into a session the client
 * can pull segment by segment, and proxies every byte so the signed CDN URL and
 * its CORS rules never reach the page.
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const SESSION_TTL = 40 * 60_000;
const MAX_SEGMENTS = 40_000;

const sessions = new Map();

function attrs(tag) {
  const out = {};
  for (const match of String(tag ?? '').matchAll(/([\w:-]+)="([^"]*)"/g)) out[match[1]] = match[2];
  return out;
}

/** DASH `frameRate` is either `24` or a rational `24000/1001`. */
function frameRate(text) {
  if (!text) return null;
  const value = String(text).trim();
  const [top, bottom] = value.split('/');
  const numerator = Number(top);
  const denominator = bottom ? Number(bottom) : 1;
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return null;
  const fps = numerator / denominator;
  return fps > 1 && fps < 240 ? Math.round(fps * 1000) / 1000 : null;
}

function isoDuration(text) {
  if (!text) return 0;
  const match = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(String(text).trim());
  if (!match) return 0;
  const [, days, hours, minutes, seconds] = match;
  return Number(days ?? 0) * 86_400 + Number(hours ?? 0) * 3600 + Number(minutes ?? 0) * 60 + Number(seconds ?? 0);
}

const unescapeXml = (value) => String(value ?? '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');

function resolveUrl(value, base) {
  if (!value) return null;
  try {
    return new URL(unescapeXml(value), base).href;
  } catch {
    return null;
  }
}

function rankTracks(candidates, { preferAvc = false } = {}) {
  if (!candidates.length) return [];
  const score = (rep) => {
    const avc = /^avc1/i.test(rep.codecs ?? '');
    const hevc = /^(hev1|hvc1)/i.test(rep.codecs ?? '');
    let value = rep.bandwidth ?? 0;
    if (preferAvc && avc) value += 10_000_000;
    if (!avc && !hevc) value -= 5_000_000;
    return value;
  };
  return [...candidates].sort((a, b) => score(b) - score(a));
}

function pickTrack(candidates, options) {
  return rankTracks(candidates, options)[0] ?? null;
}

/**
 * Pull the two renditions the player needs out of an MPD.
 *
 * `$Number$` templates are required: the player fetches segments by index, and
 * a `$Time$` timeline would need a segment timeline the providers do not emit.
 */
export function parseMpd(xml, mpdUrl) {
  const mpdAttrs = attrs(/<MPD\b[^>]*>/.exec(xml)?.[0]);
  const duration = isoDuration(mpdAttrs.mediaPresentationDuration);
  // Some manifests omit `duration` on the template and only state the segment
  // length once, on the MPD itself.
  const maxSegment = isoDuration(mpdAttrs.maxSegmentDuration);
  const mpdBase = resolveUrl(/<BaseURL>([^<]*)<\/BaseURL>/.exec(xml)?.[1], mpdUrl) ?? mpdUrl;
  const mpdTemplate = /<SegmentTemplate\b[^>]*\/?>/.exec(xml)?.[0] ?? null;

  const video = [];
  const audio = [];

  for (const setMatch of xml.matchAll(/<AdaptationSet\b([^>]*)>([\s\S]*?)<\/AdaptationSet>/g)) {
    const setAttrs = attrs(setMatch[1]);
    const body = setMatch[2];
    const setBase = resolveUrl(/<BaseURL>([^<]*)<\/BaseURL>/.exec(body)?.[1], mpdBase) ?? mpdBase;
    const setTemplate = /<SegmentTemplate\b[^>]*\/?>/.exec(body)?.[0] ?? mpdTemplate;
    const kind = setAttrs.contentType
      ?? (/audio/i.test(setAttrs.mimeType ?? '') ? 'audio' : /video/i.test(setAttrs.mimeType ?? '') ? 'video' : null);
    if (kind !== 'video' && kind !== 'audio') continue;

    for (const repMatch of body.matchAll(/<Representation\b([^>]*?)(?:\/>|>([\s\S]*?)<\/Representation>)/g)) {
      const repAttrs = attrs(repMatch[1]);
      const repBody = repMatch[2] ?? '';
      const template = /<SegmentTemplate\b[^>]*\/?>/.exec(repBody)?.[0] ?? setTemplate;
      if (!template) continue;

      const tAttrs = attrs(template);
      if (!tAttrs.media || !tAttrs.initialization) continue;
      if (!/\$Number(?:%0\d+d)?\$/.test(tAttrs.media)) continue;

      const repId = repAttrs.id ?? '0';
      const base = resolveUrl(/<BaseURL>([^<]*)<\/BaseURL>/.exec(repBody)?.[1], setBase) ?? setBase;
      const timescale = Number(tAttrs.timescale ?? 1) || 1;
      const segmentDuration = Number(tAttrs.duration ?? 0) / timescale || maxSegment;
      if (!segmentDuration) continue;

      const initUrl = resolveUrl(tAttrs.initialization.replace(/\$RepresentationID\$/g, repId), base);
      const mediaUrl = resolveUrl(tAttrs.media.replace(/\$RepresentationID\$/g, repId), base);
      if (!initUrl || !mediaUrl) continue;

      const entry = {
        repId,
        codecs: repAttrs.codecs ?? (kind === 'audio' ? 'mp4a.40.2' : 'avc1.4d401f'),
        bandwidth: Number(repAttrs.bandwidth ?? 0),
        width: Number(repAttrs.width ?? 0),
        height: Number(repAttrs.height ?? 0),
        // A subtitle timed for 25 fps drifts against a 23.976 fps master. The
        // manifest knows which one this is, so the caption selector can pick a
        // track with the same clock instead of guessing from the runtime.
        frameRate: frameRate(repAttrs.frameRate ?? setAttrs.frameRate),
        initUrl,
        // Keep the number token but normalise its padding into a known field.
        mediaUrl: mediaUrl.replace(/\$Number%0(\d+)d\$/, (_, width) => `$Number${width}$`),
        numberPad: Number(/\$Number%0(\d+)d\$/.exec(mediaUrl)?.[1] ?? 0),
        startNumber: Number(tAttrs.startNumber ?? 1),
        segmentDuration,
        segments: Math.min(MAX_SEGMENTS, Math.ceil((duration || 0) / segmentDuration)),
      };
      (kind === 'video' ? video : audio).push(entry);
    }
  }

  if (!video.length || !audio.length) return null;

  const videos = rankTracks(video, { preferAvc: true });

  return {
    duration,
    video: videos[0],
    videos,
    audio: pickTrack(audio),
  };
}

function segmentUrl(track, number) {
  const value = track.numberPad ? String(number).padStart(track.numberPad, '0') : String(number);
  return track.mediaUrl.replace(/\$Number\d*\$/, value);
}

function prune() {
  const now = Date.now();
  for (const [sid, session] of sessions) {
    if (now - session.createdAt > SESSION_TTL) sessions.delete(sid);
  }
}

export function dashSegmentUrl(track, index) {
  return index === 0 ? track.initUrl : segmentUrl(track, track.startNumber + index - 1);
}

/** Fetch a manifest and pull the two renditions out of it. */
export async function loadDashManifest(mpdUrl, referer = null) {
  let xml;
  try {
    const res = await fetch(mpdUrl, {
      headers: {
        'user-agent': UA,
        accept: '*/*',
        ...(referer ? { referer, origin: referer } : {}),
      },
    });
    if (!res.ok) return { ok: false, error: `manifest ${res.status} ${res.statusText}` };
    xml = await res.text();
  } catch (err) {
    return { ok: false, error: `manifest fetch failed: ${err.message}` };
  }

  const parsed = parseMpd(xml, mpdUrl);
  if (!parsed) return { ok: false, error: 'manifest has no playable video/audio pair' };

  return { ok: true, duration: parsed.duration, video: parsed.video, videos: parsed.videos, audio: parsed.audio };
}

/**
 * Resolve a title to its DASH tracks: a manifest fetch, then the two renditions
 * the player or the downloader needs. Shared by live playback and by download,
 * which is why it returns the internal track records (signed URLs included)
 * instead of the client-facing payload.
 */
export async function resolveDashTracks({ tmdbId, imdbId = null, season = null, episode = null }) {
  const resolved = await resolveStream({ tmdbId, imdbId, season, episode });
  if (resolved.type !== 'dash') {
    return { ok: false, error: resolved.error ?? `resolver returned ${resolved.type ?? 'nothing'}` };
  }

  const mpdUrl = resolved.url;
  const referer = resolved.referer ?? (() => {
    try {
      return new URL(resolved.page).origin;
    } catch {
      return null;
    }
  })();

  const manifest = await loadDashManifest(mpdUrl, referer);
  if (!manifest.ok) return manifest;

  return {
    ok: true,
    mpdUrl,
    referer,
    page: resolved.page ?? null,
    duration: manifest.duration,
    video: manifest.video,
    videos: manifest.videos,
    audio: manifest.audio,
  };
}

/**
 * Register already-resolved tracks as a live session and hand the client the
 * shape its MSE feeder expects. The download job reuses the same tracks, so one
 * resolver run both plays and caches a title.
 */
/**
 * Register one rendition as a live session and return its client payload.
 *
 * Every rendition is registered up front — a quality switch then costs no
 * network at all, which matters because the feeder keeps the browser's
 * six-connection pool busy for the whole film.
 */
function registerDashSession(id, found, videos, video, index) {
  const sid = randomUUID();
  const session = {
    sid,
    id,
    createdAt: Date.now(),
    referer: found.referer,
    duration: found.duration,
    segmentDuration: video.segmentDuration,
    startNumber: video.startNumber,
    segments: video.segments,
    video,
    videos,
    audio: found.audio,
    page: found.page ?? null,
    variantIndex: index,
  };
  sessions.set(sid, session);

  return {
    ok: true,
    sid,
    duration: Math.round(found.duration * 1000) / 1000,
    segmentDuration: session.segmentDuration,
    startNumber: session.startNumber,
    segments: session.segments,
    quality: video.height ? `${video.height}p` : 'auto',
    variants: videos.map((rep, at) => ({
      index: at,
      height: rep.height,
      bandwidth: rep.bandwidth,
      label: rep.height ? `${rep.height}p` : `${(rep.bandwidth / 1_000_000).toFixed(1)} Mbps`,
    })),
    variant: index,
    video: {
      codecs: video.codecs,
      mime: `video/mp4; codecs="${video.codecs}"`,
      width: video.width,
      height: video.height,
      bandwidth: video.bandwidth,
      frameRate: video.frameRate ?? null,
    },
    audio: {
      codecs: found.audio.codecs,
      mime: `audio/mp4; codecs="${found.audio.codecs}"`,
      bandwidth: found.audio.bandwidth,
    },
    page: found.page ?? null,
  };
}

export function createDashSession(id, found, variantIndex = null) {
  prune();

  const videos = found.videos?.length ? found.videos : [found.video];
  const index = Number.isInteger(variantIndex)
    ? Math.max(0, Math.min(variantIndex, videos.length - 1))
    : Math.max(0, videos.indexOf(found.video));

  const built = videos.map((video, at) => registerDashSession(id, found, videos, video, at));
  const payload = built[index];

  // `renditions` is the whole ladder, each entry a ready session. The client
  // swaps `session` and remounts at the playhead — no request, no waiting.
  // Copies, not references: a session that carried the ladder inside itself
  // would be circular and could not be serialised.
  payload.renditions = built.map((entry) => ({
    index: entry.variant,
    label: entry.quality,
    bandwidth: entry.video.bandwidth,
    session: { ...entry },
  }));

  return payload;
}

/**
 * Re-open a live DASH session on a different video rendition.
 *
 * Audio is untouched: only the video track carries the ladder. The client
 * remounts its feeder at the current playhead, so the switch is a clean cut.
 */
export function switchDashVariant(sid, index) {
  const session = sessions.get(String(sid));
  if (!session) return { ok: false, error: 'session expired' };
  const videos = session.videos ?? [];
  if (videos.length < 2) return { ok: false, error: 'this stream has one rendition' };
  if (!Number.isInteger(index) || index < 0 || index >= videos.length) {
    return { ok: false, error: 'unknown quality' };
  }

  return createDashSession(session.id, {
    referer: session.referer,
    duration: session.duration,
    video: videos[index],
    videos,
    audio: session.audio,
    page: session.page,
  }, index);
}

/**
 * Resolve `id` to a live DASH session. Returns `{ ok: true, ... }` or
 * `{ ok: false, error }` — the caller falls back to embeds either way.
 */
export async function openDashSession({ id, tmdbId, imdbId = null, season = null, episode = null }) {
  const found = await resolveDashTracks({ tmdbId, imdbId, season, episode });
  if (!found.ok) return found;
  return createDashSession(id, found);
}

/** Fetch one segment (0 = init) and hand the bytes to the caller. */
export async function readSegment(sid, trackName, number) {
  const session = sessions.get(sid);
  if (!session) return { error: 'session expired', status: 410 };
  const track = session[trackName];
  if (!track) return { error: 'unknown track', status: 404 };

  const index = Number(number);
  if (!Number.isInteger(index) || index < 0) return { error: 'bad segment', status: 400 };
  if (index > track.segments) return { error: 'segment out of range', status: 416 };

  const url = index === 0 ? track.initUrl : segmentUrl(track, track.startNumber + index - 1);
  const headers = { 'user-agent': UA, accept: '*/*' };
  if (session.referer) {
    headers.referer = session.referer;
    headers.origin = session.referer;
  }

  let upstream;
  try {
    upstream = await fetch(url, { headers });
  } catch (err) {
    return { error: `segment fetch failed: ${err.message}`, status: 502 };
  }
  if (!upstream.ok) return { error: `segment ${upstream.status}`, status: 502 };

  const bytes = Buffer.from(await upstream.arrayBuffer());
  return {
    status: 200,
    bytes,
    contentType: upstream.headers.get('content-type') ?? 'video/iso.segment',
    cacheControl: 'private, max-age=300',
  };
}
