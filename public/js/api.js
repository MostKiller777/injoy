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
export async function api(path, { method = 'GET', body, timeout = 15_000, retries = 1, signal } = {}) {
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
        headers: body ? JSON_HEADERS : undefined,
        body: body ? JSON.stringify(body) : undefined,
        cache: 'no-store',
      });

      if (!res.ok) {
        const detail = await res.json().catch(() => ({}));
        const err = new ApiError(res.status, detail.error ?? `request failed (${res.status})`);
        if (res.status < 500 && res.status !== 429) throw err;
        lastError = err;
      } else {
        return await res.json();
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

export const getHome = (signal) => api('/api/home', { signal });
export const getSearch = (q, page = 1, signal) => api(`/api/search?q=${encodeURIComponent(q)}&page=${page}`, { signal });
export const getBrowse = ({ page = 1, genre = '', sort = 'popular' } = {}, signal) =>
  api(`/api/browse?page=${page}&genre=${encodeURIComponent(genre)}&sort=${encodeURIComponent(sort)}`, { signal });
export const getGenres = () => api('/api/genres');
export const getSeries = (signal) => api('/api/series', { signal });

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

export const getWatchlist = () => api('/api/watchlist', { cache: 'no-store' });
export const putWatchlist = (item) => api('/api/watchlist', { method: 'POST', body: { item } });
export const deleteWatchlist = (id) => api(`/api/watchlist/${encodeURIComponent(id)}`, { method: 'DELETE' });

export const getProgressAll = () => api('/api/progress');
export const postProgress = (id, t, d) =>
  api(`/api/progress/${encodeURIComponent(id)}`, { method: 'POST', body: { t, d } });
