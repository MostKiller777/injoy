import { getJson } from './http.js';

const BASE = 'https://api.themoviedb.org/3';
export const IMAGE_BASE = 'https://image.tmdb.org/t/p';

export function tmdbEnabled() {
  return Boolean(process.env.TMDB_API_KEY);
}

export function image(path, size = 'w500') {
  if (!path) return null;
  if (/^https?:\/\//i.test(path)) return path;
  return `${IMAGE_BASE}/${size}${path.startsWith('/') ? path : `/${path}`}`;
}

/**
 * TMDB accepts either a v3 api_key or a v4 bearer token. Both are handled here.
 */
async function api(path, params = {}) {
  if (!tmdbEnabled()) throw new Error('TMDB_API_KEY is not configured');
  const url = new URL(BASE + path);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }

  const key = process.env.TMDB_API_KEY.trim();
  const headers = {};
  if (key.startsWith('eyJ')) headers.authorization = `Bearer ${key}`;
  else url.searchParams.set('api_key', key);

  return getJson(url, { timeout: 9000, headers, retries: 1 });
}

const region = () => process.env.TMDB_REGION || 'US';

export const trending = (page = 1) => api('/trending/movie/week', { page, language: 'en-US' });
export const popular = (page = 1) => api('/movie/popular', { page, region: region(), language: 'en-US' });
export const topRated = (page = 1) => api('/movie/top_rated', { page, region: region(), language: 'en-US' });
export const nowPlaying = (page = 1) => api('/movie/now_playing', { page, region: region(), language: 'en-US' });
export const upcoming = (page = 1) => api('/movie/upcoming', { page, region: region(), language: 'en-US' });

export const search = (query, page = 1) =>
  api('/search/movie', { query, page, include_adult: false, language: 'en-US' });

export const genres = () => api('/genre/movie/list', { language: 'en-US' });

export const detail = (id) =>
  api(`/movie/${id}`, {
    language: 'en-US',
    append_to_response: 'credits,videos,similar,recommendations,release_dates,external_ids',
  });

export const discover = (params = {}) =>
  api('/discover/movie', {
    language: 'en-US',
    include_adult: false,
    'vote_count.gte': 25,
    ...params,
  });
