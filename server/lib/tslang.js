/**
 * What language a transport stream actually speaks.
 *
 * Provider encodes are often dual-audio: two audio PIDs in one TS, and the
 * player takes the first. On a dual Hindi/English release that means the film
 * opens in Hindi while the page says nothing about it. The PMT carries ISO-639
 * descriptors for each elementary stream, so the answer is in the first segment
 * — one small ranged fetch, no decoding.
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const PROBE_BYTES = 400_000;
const TIMEOUT_MS = 8_000;

const PACKET = 188;

function readSection(buf, from) {
  const start = from;
  if (start + 3 > buf.length) return null;
  const length = ((buf[start + 1] & 0x0f) << 8) | buf[start + 2];
  const end = start + 3 + length - 4;
  if (end > buf.length) return null;
  return { start, end };
}

/** Languages of every audio elementary stream, in PID order. */
export function audioLanguages(buf) {
  let pmtPid = -1;

  for (let at = 0; at + PACKET <= buf.length; at += PACKET) {
    if (buf[at] !== 0x47) continue;
    const pid = ((buf[at + 1] & 0x1f) << 8) | buf[at + 2];
    if (pid !== 0) continue;
    let off = at + 4;
    if (buf[at + 1] & 0x40) off += 1 + buf[off];
    if (buf[off] !== 0x00) continue;
    const section = readSection(buf, off);
    if (!section) continue;
    for (let p = off + 8; p + 4 <= section.end; p += 4) {
      const program = (buf[p] << 8) | buf[p + 1];
      if (program === 0) continue;
      pmtPid = ((buf[p + 2] & 0x1f) << 8) | buf[p + 3];
      break;
    }
    break;
  }

  if (pmtPid < 0) return [];

  const languages = [];
  for (let at = 0; at + PACKET <= buf.length; at += PACKET) {
    if (buf[at] !== 0x47) continue;
    const pid = ((buf[at + 1] & 0x1f) << 8) | buf[at + 2];
    if (pid !== pmtPid) continue;
    let off = at + 4;
    if (buf[at + 1] & 0x40) off += 1 + buf[off];
    if (buf[off] !== 0x02) continue;
    const section = readSection(buf, off);
    if (!section) continue;
    const programInfoLength = ((buf[off + 10] & 0x0f) << 8) | buf[off + 11];
    let p = off + 12 + programInfoLength;
    while (p + 5 <= section.end) {
      const streamType = buf[p];
      const esInfoLength = ((buf[p + 3] & 0x0f) << 8) | buf[p + 4];
      const infoStart = p + 5;
      let lang = null;
      let d = infoStart;
      while (d + 2 <= infoStart + esInfoLength && d + 2 <= section.end) {
        const tag = buf[d];
        const len = buf[d + 1];
        if (tag === 0x0a && d + 5 <= section.end) {
          lang = String.fromCharCode(buf[d + 2], buf[d + 3], buf[d + 4]).toLowerCase();
        }
        d += 2 + len;
      }
      // 0x03/0x04/0x0f/0x11 are the MPEG audio and AAC stream types.
      if (lang && [0x03, 0x04, 0x0f, 0x11].includes(streamType)) languages.push(lang);
      p = infoStart + esInfoLength;
    }
    break;
  }

  return languages;
}

async function text(url, headers) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  timer.unref?.();
  try {
    const res = await fetch(url, { signal: controller.signal, headers });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Default audio language of an HLS manifest: the first audio PID the player
 * would pick. Returns a three-letter code, or null when nothing could be read.
 */
export async function manifestAudioLanguage(manifestUrl, referer = null) {
  const headers = { 'user-agent': UA, ...(referer ? { referer, origin: referer } : {}) };

  let mediaUrl = manifestUrl;
  let body = await text(mediaUrl, headers);
  if (!body) return null;

  if (/#EXT-X-STREAM-INF/.test(body)) {
    const variant = body.split('\n').find((line) => line && !line.startsWith('#'));
    if (!variant) return null;
    mediaUrl = new URL(variant.trim(), mediaUrl).href;
    body = await text(mediaUrl, headers);
    if (!body) return null;
  }

  const first = body.split('\n').find((line) => line && !line.startsWith('#'));
  if (!first) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  timer.unref?.();
  try {
    const res = await fetch(new URL(first.trim(), mediaUrl).href, {
      signal: controller.signal,
      headers: { ...headers, range: `bytes=0-${PROBE_BYTES}` },
    });
    if (!res.ok && res.status !== 206) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return audioLanguages(buf)[0] ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
