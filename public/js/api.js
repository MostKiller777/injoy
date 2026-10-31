const JSON_HEADERS = { 'content-type': 'application/json' };

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/**
 * JSON fetch with a hard timeout and one retry on transient failure.
 * Every caller gets an AbortController-managed request so a fast route change
 * cannot land a stale render on top of a fresh one.
 */
// A list response is stable for a minute and the same page asks for it again
// on every home/search/genre hop. Keeping the parsed value removes the round
// trip entirely without making the catalogue stale for long.
const memo = new Map();
const MEMO_TTL = 60_000;

export async function api(path, { method = 'GET', body, timeout = 15_000, retries = 1, signal, cacheable = false, headers = {} } = {}) {
  if (cacheable && method === 'GET') {
    const hit = memo.get(path);
    if (hit && Date.now() - hit.at < MEMO_TTL) return hit.value;
  }
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('timeout')), timeout);
    const onAbort = () => controller.abort(new Error('cancelled'));
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const res = await fetch(path, {
        method,
        signal: controller.signal,
        headers: body || Object.keys(headers).length
          ? { ...(body ? JSON_HEADERS : {}), ...headers }
          : undefined,
        body: body ? JSON.stringify(body) : undefined,
        cache: 'no-store',
      });

      if (!res.ok) {
        const detail = await res.json().catch(() => ({}));
        const err = new ApiError(res.status, detail.error ?? `request failed (${res.status})`);
        if (res.status < 500 && res.status !== 429) throw err;
        lastError = err;
      } else {
        const value = await res.json();
        if (cacheable && method === 'GET') {
          if (memo.size > 40) memo.clear();
          memo.set(path, { at: Date.now(), value });
        }
        return value;
      }
    } catch (err) {
      if (err instanceof ApiError && err.status < 500 && err.status !== 429) throw err;
      if (signal?.aborted) throw err;
      lastError = err;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }

    if (attempt < retries) await new Promise((resolve) => setTimeout(resolve, 320));
  }

  throw lastError ?? new Error('network failure');
}

export const getHome = (signal) => api('/api/home', { signal, cacheable: true });
export const getSearch = (q, page = 1, signal) =>
  api(`/api/search?q=${encodeURIComponent(q)}&page=${page}`, { signal, cacheable: true });
export const getBrowse = ({ page = 1, genre = '', sort = 'popular' } = {}, signal) =>
  api(`/api/browse?page=${page}&genre=${encodeURIComponent(genre)}&sort=${encodeURIComponent(sort)}`, { signal, cacheable: true });
export const getGenres = () => api('/api/genres', { cacheable: true });
export const getSeries = (signal) => api('/api/series', { signal, cacheable: true });

/** Admin panel: search Cinemeta, add one film, list or remove custom films. */
const adminHeaders = (key) => (key ? { 'x-admin-key': String(key) } : {});

export const adminSearch = (q, key) =>
  api(`/api/admin/search?q=${encodeURIComponent(q)}`, { headers: adminHeaders(key), timeout: 20_000, retries: 0 });

export const adminAdd = (imdbId, key) =>
  api('/api/admin/add', { method: 'POST', body: { imdbId }, headers: adminHeaders(key), timeout: 60_000, retries: 0 });

export const adminCustom = (key) =>
  api('/api/admin/custom', { headers: adminHeaders(key), timeout: 15_000, retries: 0 });

export const adminRemove = (tmdbId, key) =>
  api('/api/admin/remove', { method: 'POST', body: { tmdbId }, headers: adminHeaders(key), timeout: 15_000, retries: 0 });

/** A new film must not hide behind the 60-second list memo. */
export function invalidateCatalog() {
  memo.clear();
}

export const getLocal = (signal) => api('/api/local', { signal });
export const getDownload = (id, signal) => api(`/api/download/${encodeURIComponent(id)}`, { signal });
export const startDownload = (id, title) => api(`/api/download/${encodeURIComponent(id)}`, {
  method: 'POST',
  body: { title },
  timeout: 20_000,
});
export const cancelDownload = (id) => api(`/api/download/${encodeURIComponent(id)}`, { method: 'DELETE' });
export const getDetail = (id, signal) => api(`/api/movie/${encodeURIComponent(id)}`, { signal });
export const getSources = (id, signal) => api(`/api/sources/${encodeURIComponent(id)}`, { signal });
export const getPlay = (id, signal) => api(`/api/play/${encodeURIComponent(id)}`, {
  signal,
  timeout: 90_000,
  retries: 0,
});
export const getRandom = () => api('/api/random');

// Captions for one title: every language the index has, as WebVTT endpoints.
export const getSubtitles = (id, duration = null, fps = null) => {
  const params = new URLSearchParams();
  if (Number.isFinite(duration) && duration > 0) params.set('d', String(Math.round(duration)));
  if (Number.isFinite(fps) && fps > 0) params.set('f', String(fps));
  const query = params.toString();
  return api(`/api/subs/${encodeURIComponent(id)}${query ? `?${query}` : ''}`, { timeout: 20_000, retries: 0 });
};

// Re-open a live stream on another rendition; the reply is a fresh session.
export const getHlsVariant = (sid, index) =>
  api(`/api/hls/variant/${encodeURIComponent(sid)}/${index}`, { timeout: 30_000 });
export const getDashVariant = (sid, index) =>
  api(`/api/dash/variant/${encodeURIComponent(sid)}/${index}`, { timeout: 30_000 });

export const getWatchlist = () => api('/api/watchlist', { cache: 'no-store' });
export const putWatchlist = (item) => api('/api/watchlist', { method: 'POST', body: { item } });
export const deleteWatchlist = (id) => api(`/api/watchlist/${encodeURIComponent(id)}`, { method: 'DELETE' });

export const getProgressAll = () => api('/api/progress');
export const postProgress = (id, t, d) =>
  api(`/api/progress/${encodeURIComponent(id)}`, { method: 'POST', body: { t, d } });
