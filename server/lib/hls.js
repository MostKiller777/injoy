import { createDecipheriv, randomUUID } from 'node:crypto';

import { probeTsCodecs, tsMime } from './tscodec.js';

/**
 * Live HLS.
 *
 * DASH hands over two tracks and a segment template; HLS hands over a playlist
 * of URLs, one per few seconds of media, with audio and video already muxed. The
 * player still feeds Media Source Extensions, so what it needs from here is the
 * same shape the DASH session provides: a segment count, a duration map, and one
 * proxy URL per index.
 *
 * The playlist itself is parsed once and kept for the life of the session. The
 * segment URLs are fetched on demand, through this server, because the browser
 * cannot set the Referer the provider demands and the CDN sends no CORS header.
 *
 * Encryption is handled the way the downloader handles it: AES-128 with an
 * explicit IV or one derived from the media sequence number.
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const SESSION_TTL = 30 * 60 * 1000;
const MAX_SEGMENTS = 20_000;
const MAX_PLAYLIST_BYTES = 4 * 1024 * 1024;

const sessions = new Map();

function prune() {
  const now = Date.now();
  for (const [sid, session] of sessions) {
    if (now - session.createdAt > SESSION_TTL) sessions.delete(sid);
  }
}

function parseAttributes(line) {
  const out = {};
  for (const match of line.matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g)) {
    out[match[1]] = match[2].replace(/^"|"$/g, '');
  }
  return out;
}

function absolute(base, ref) {
  try {
    return new URL(ref, base).toString();
  } catch {
    return ref;
  }
}

async function fetchText(url, headers) {
  const res = await fetch(url, { headers: { 'user-agent': UA, accept: '*/*', ...headers } });
  if (!res.ok) throw new Error(`playlist ${res.status} ${res.statusText}`);
  const text = await res.text();
  if (text.length > MAX_PLAYLIST_BYTES) throw new Error('playlist is too large to be HLS');
  if (!text.includes('#EXTM3U')) throw new Error('not an HLS playlist');
  return text;
}

/** Master playlist → highest-bandwidth variant. Media playlist → itself. */
async function mediaPlaylist(url, headers, depth = 0) {
  if (depth > 4) throw new Error('playlist nesting too deep');
  const text = await fetchText(url, headers);

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
    const chosen = await mediaPlaylist(variants[0].url, headers, depth + 1);
    // Keep the master playlist's declaration: the media playlist carries no
    // resolution of its own, and the player shows this as the quality label.
    return { ...chosen, variant: chosen.variant ?? variants[0] };
  }

  return { url, text, variant: null };
}

/** Media playlist → segments with their durations, init map and key. */
function parseMedia(url, text) {
  const lines = text.split(/\r?\n/).map((line) => line.trim());

  const segments = [];
  const durations = [];
  let map = null;
  let key = null;
  let pendingRange = null;
  let pendingDuration = 0;
  let sequence = 0;
  let total = 0;

  for (const line of lines) {
    if (!line) continue;

    if (line.startsWith('#EXT-X-MAP:')) {
      const attrs = parseAttributes(line.slice(line.indexOf(':') + 1));
      if (attrs.URI) map = { url: absolute(url, attrs.URI), range: attrs.BYTERANGE ?? null };
      continue;
    }

    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      sequence = Number(line.split(':')[1]) || 0;
      continue;
    }

    if (line.startsWith('#EXT-X-KEY:')) {
      const attrs = parseAttributes(line.slice(line.indexOf(':') + 1));
      if (!attrs.METHOD || attrs.METHOD === 'NONE') key = null;
      else if (attrs.METHOD === 'AES-128') key = { url: absolute(url, attrs.URI), iv: attrs.IV ?? null };
      else throw new Error(`unsupported HLS encryption: ${attrs.METHOD}`);
      continue;
    }

    if (line.startsWith('#EXT-X-BYTERANGE:')) {
      pendingRange = line.slice(line.indexOf(':') + 1);
      continue;
    }

    if (line.startsWith('#EXTINF:')) {
      pendingDuration = Number(line.slice(line.indexOf(':') + 1).split(',')[0]) || 0;
      continue;
    }

    if (line.startsWith('#')) continue;

    const index = segments.length;
    if (index >= MAX_SEGMENTS) break;
    segments.push({
      url: absolute(url, line),
      range: pendingRange,
      key: key ? { ...key, sequence: sequence + index } : null,
    });
    durations.push(pendingDuration);
    total += pendingDuration;
    pendingRange = null;
    pendingDuration = 0;
  }

  return { segments, durations, map, total, encrypted: segments.some((s) => s.key) };
}

const keyCache = new Map();

async function aesKey(url, headers) {
  const cached = keyCache.get(url);
  if (cached && cached.expires > Date.now()) return cached.bytes;
  const res = await fetch(url, { headers: { 'user-agent': UA, ...headers } });
  if (!res.ok) throw new Error(`key ${res.status} ${res.statusText}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length !== 16) throw new Error('AES key is not 16 bytes');
  keyCache.set(url, { bytes, expires: Date.now() + 10 * 60 * 1000 });
  return bytes;
}

function decrypt(bytes, keyBytes, ivHex, sequence) {
  let iv;
  if (ivHex) {
    const clean = ivHex.replace(/^0x/i, '').padStart(32, '0');
    iv = Buffer.from(clean, 'hex');
  } else {
    iv = Buffer.alloc(16);
    iv.writeBigUInt64BE(BigInt(sequence), 8);
  }
  const decipher = createDecipheriv('aes-128-cbc', keyBytes, iv);
  return Buffer.concat([decipher.update(bytes), decipher.final()]);
}

function rangeHeader(range) {
  if (!range) return null;
  const [lengthRaw, offsetRaw] = String(range).split('@');
  const length = Number(lengthRaw);
  const offset = Number(offsetRaw ?? 0);
  if (!Number.isFinite(length) || length <= 0) return null;
  return `bytes=${offset}-${offset + length - 1}`;
}

/**
 * Read the head of a segment without downloading the whole thing.
 *
 * The PMT lives in the first packet or two, so a Range request for a few
 * hundred kilobytes is plenty; when the CDN ignores Range the reader stops
 * after the same byte count and the response is cancelled.
 */
async function fetchHead(url, headers, limit = 384 * 1024) {
  const controller = new AbortController();
  try {
    const res = await fetch(url, {
      headers: { ...headers, range: `bytes=0-${limit - 1}` },
      signal: controller.signal,
    });
    if (!res.ok && res.status !== 206) throw new Error(`head ${res.status} ${res.statusText}`);
    const reader = res.body?.getReader();
    if (!reader) return Buffer.from(await res.arrayBuffer()).subarray(0, limit);

    const chunks = [];
    let size = 0;
    while (size < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
      size += value.length;
    }
    return Buffer.concat(chunks).subarray(0, limit);
  } finally {
    controller.abort();
  }
}

/** Mime candidates for a muxed TS playlist: the probed one first, then guesses. */
function tsMimes(codecs) {
  const list = [tsMime(codecs)];
  if (!codecs) {
    list.push('video/mp2t; codecs="avc1.42E01E,mp4a.40.2"');
    list.push('video/mp2t; codecs="hev1.1.6.L120.90,mp4a.40.2"');
  } else if (codecs.video.startsWith('hev') || codecs.video.startsWith('hvc')) {
    list.push('video/mp2t; codecs="avc1.42E01E,mp4a.40.2"');
  } else {
    list.push('video/mp2t; codecs="hev1.1.6.L120.90,mp4a.40.2"');
  }
  return [...new Set(list)];
}

const FMP4_MIMES = [
  'video/mp4; codecs="avc1.42E01E,mp4a.40.2"',
  'video/mp4; codecs="hev1.1.6.L120.90,mp4a.40.2"',
  'video/mp4; codecs="avc1.640028,mp4a.40.2"',
];

/**
 * Resolve a manifest URL into a live session the player can drive. Returns
 * `{ ok: true, ...clientPayload }` or `{ ok: false, error }`.
 */
export async function openHlsSession({ id, url, referer = null }) {
  prune();

  const headers = referer ? { referer, origin: referer } : {};
  let media;
  try {
    media = await mediaPlaylist(url, headers);
  } catch (err) {
    return { ok: false, error: err.message };
  }

  let parsed;
  try {
    parsed = parseMedia(media.url, media.text);
  } catch (err) {
    return { ok: false, error: err.message };
  }

  if (!parsed.segments.length) return { ok: false, error: 'playlist has no segments' };
  if (parsed.segments.some((s) => s.key)) {
    // Probe the key now: a dead key would fail on the first segment otherwise,
    // and the caller can still fall back to an embed instead of a black frame.
    try {
      await aesKey(parsed.segments.find((s) => s.key).key.url, headers);
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  const sid = randomUUID();
  sessions.set(sid, {
    sid,
    id,
    createdAt: Date.now(),
    referer,
    segments: parsed.segments,
    durations: parsed.durations,
    map: parsed.map,
    duration: parsed.total,
  });

  // fMP4 playlists carry an init segment and want video/mp4; transport streams
  // are muxed and go straight into a video/mp2t SourceBuffer.
  const fmp4 = Boolean(parsed.map);
  const height = Number(String(media.variant?.resolution ?? '').split('x')[1]) || 0;

  // MSE refuses a bare container type, so the TS codecs are read from the PMT
  // in the first segment. A failure here is not fatal: the client walks the
  // candidate list until one SourceBuffer is accepted.
  let mimes = FMP4_MIMES;
  if (!fmp4) {
    const first = parsed.segments[0];
    let codecs = null;
    try {
      const probeHeaders = {
        'user-agent': UA,
        ...(referer ? { referer, origin: referer } : {}),
      };
      const range = rangeHeader(first.range);
      if (range) probeHeaders.range = range;
      let head = await fetchHead(first.url, probeHeaders);
      if (first.key) head = decrypt(head, await aesKey(first.key.url, probeHeaders), first.key.iv, first.key.sequence);
      codecs = probeTsCodecs(head);
    } catch {
      codecs = null;
    }
    mimes = tsMimes(codecs);
  }

  return {
    ok: true,
    sid,
    container: fmp4 ? 'hls-fmp4' : 'hls',
    quality: height ? `${height}p` : 'auto',
    duration: Math.round(parsed.total * 1000) / 1000,
    segments: parsed.segments.length,
    durations: parsed.durations,
    segmentDuration: parsed.durations.length
      ? Math.round((parsed.total / parsed.durations.length) * 1000) / 1000
      : 4,
    mime: mimes[0],
    mimes,
    hasMap: fmp4,
    base: `/api/hls/seg/${sid}`,
  };
}

/** One playlist segment, proxied (and decrypted when the playlist says so). */
export async function readHlsSegment(sid, index) {
  const session = sessions.get(String(sid));
  if (!session) return { error: 'session expired', status: 404 };

  // index 0 is the init segment when the playlist has one; segments then run
  // 1..n so the client's numbering matches DASH's.
  let target;
  if (index === 0 && session.map) target = session.map;
  else target = session.segments[index - (session.map ? 1 : 0)];
  if (!target) return { error: 'segment out of range', status: 404 };

  const headers = {
    'user-agent': UA,
    accept: '*/*',
    ...(session.referer ? { referer: session.referer, origin: session.referer } : {}),
  };
  const range = rangeHeader(target.range);
  if (range) headers.range = range;

  try {
    const res = await fetch(target.url, { headers });
    if (!res.ok) return { error: `segment ${index}: HTTP ${res.status}`, status: 502 };
    let bytes = Buffer.from(await res.arrayBuffer());

    if (target.key) {
      const keyBytes = await aesKey(target.key.url, headers);
      bytes = decrypt(bytes, keyBytes, target.key.iv, target.key.sequence);
    }

    return {
      bytes,
      contentType: session.map ? 'video/mp4' : 'video/mp2t',
      cacheControl: 'private, max-age=600',
    };
  } catch (err) {
    return { error: `segment ${index}: ${err.message}`, status: 502 };
  }
}

export function hlsSessionFor(sid) {
  const session = sessions.get(String(sid));
  return session ? { sid, segments: session.segments.length, duration: session.duration } : null;
}
