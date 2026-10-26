import { randomUUID } from 'node:crypto';

/**
 * Progressive file proxy.
 *
 * A `.mp4` from a provider plays natively, but only if the request carries the
 * Referer the CDN wants and CORS lets it through. Neither is true from a page on
 * this origin, so the bytes come through here: the browser sees a same-origin
 * URL with Range support, the provider sees the headers it expects.
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const SESSION_TTL = 30 * 60 * 1000;

const sessions = new Map();

function prune() {
  const now = Date.now();
  for (const [sid, session] of sessions) {
    if (now - session.createdAt > SESSION_TTL) sessions.delete(sid);
  }
}

export function openRawSession({ id, url, referer = null, contentType = 'video/mp4' }) {
  prune();
  const sid = randomUUID();
  sessions.set(sid, { sid, id, url, referer, contentType, createdAt: Date.now() });
  return { sid, base: `/api/raw/${sid}`, contentType };
}

function sessionFor(sid) {
  const session = sessions.get(String(sid));
  if (!session) return null;
  if (Date.now() - session.createdAt > SESSION_TTL) {
    sessions.delete(String(sid));
    return null;
  }
  return session;
}

/**
 * Fetch the file (or the requested byte range) and hand the bytes back with the
 * status and headers the browser needs to seek through them.
 */
export async function readRaw(sid, rangeHeader) {
  const session = sessionFor(sid);
  if (!session) return { error: 'session expired', status: 404 };

  const headers = {
    'user-agent': UA,
    accept: '*/*',
    ...(session.referer ? { referer: session.referer, origin: session.referer } : {}),
  };
  if (rangeHeader) headers.range = rangeHeader;

  try {
    const res = await fetch(session.url, { headers, redirect: 'follow' });
    if (!res.ok && res.status !== 206) {
      return { error: `upstream ${res.status} ${res.statusText}`, status: 502 };
    }
    const bytes = Buffer.from(await res.arrayBuffer());
    return {
      bytes,
      status: res.status === 206 ? 206 : 200,
      contentType: res.headers.get('content-type') ?? session.contentType,
      contentRange: res.headers.get('content-range'),
      acceptRanges: res.headers.get('accept-ranges') ?? 'bytes',
    };
  } catch (err) {
    return { error: err.message, status: 502 };
  }
}
