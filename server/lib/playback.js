/**
 * Who is watching right now.
 *
 * A background cache job and a live stream pull from the same provider over the
 * same connection, and the provider does not care which one a person is waiting
 * on. So the proxy notes every segment it serves for a title, and the download
 * engine throttles itself down for that title while the note is fresh: playback
 * gets the bandwidth, the cache still makes progress.
 */

const WINDOW_MS = 30_000;

const lastRead = new Map();

export function notePlaying(id) {
  const key = String(id ?? '');
  if (key) lastRead.set(key, Date.now());
}

export function isPlaying(id) {
  const at = lastRead.get(String(id ?? ''));
  return Boolean(at) && Date.now() - at < WINDOW_MS;
}

export function clearPlaying(id) {
  lastRead.delete(String(id ?? ''));
}
