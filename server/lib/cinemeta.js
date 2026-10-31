/**
 * Keyless movie metadata for the admin panel.
 *
 * Cinemeta is the same public catalogue the newest shelf is generated from. It
 * answers a title search and a per-IMDb metadata record without a key, which is
 * what makes "type a name, press Add" work on a fresh install.
 */

const BASE = 'https://v3-cinemeta.strem.io';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const TIMEOUT = 12_000;

async function getJson(url) {
  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!res.ok) throw new Error(`Cinemeta answered ${res.status}`);
  return res.json();
}

const imdbIdOf = (meta) => String(meta?.imdb_id ?? meta?.id ?? '');
const posterFor = (imdbId) => `https://images.metahub.space/poster/small/${imdbId}/img`;
const backdropFor = (imdbId) => `https://images.metahub.space/background/medium/${imdbId}/img`;

/** Search by name. Returns the fields the admin result list paints. */
export async function searchMovies(query) {
  const term = String(query ?? '').trim();
  if (term.length < 2) return [];

  const data = await getJson(`${BASE}/catalog/movie/top/search=${encodeURIComponent(term)}.json`);
  const metas = Array.isArray(data?.metas) ? data.metas : [];
  const seen = new Set();
  const results = [];

  for (const meta of metas) {
    if (meta?.type && meta.type !== 'movie') continue;
    const imdbId = imdbIdOf(meta);
    if (!/^tt\d{5,}$/.test(imdbId) || seen.has(imdbId)) continue;
    seen.add(imdbId);
    const yearMatch = /(\d{4})/.exec(String(meta.releaseInfo ?? meta.year ?? ''));
    results.push({
      imdbId,
      title: String(meta.name ?? '').trim() || imdbId,
      year: yearMatch ? Number(yearMatch[1]) : null,
      poster: posterFor(imdbId),
      backdrop: meta.background ?? backdropFor(imdbId),
      rating: Number(meta.imdbRating) || null,
      overview: meta.description ?? '',
    });
    if (results.length >= 10) break;
  }
  return results;
}

/** Fetch one movie record and turn it into a custom-film record. */
export async function filmFromImdb(imdbId) {
  if (!/^tt\d{5,}$/.test(String(imdbId))) {
    throw Object.assign(new Error('invalid IMDb id'), { status: 400 });
  }

  const data = await getJson(`${BASE}/meta/movie/${imdbId}.json`);
  const meta = data?.meta;
  if (!meta) throw Object.assign(new Error('title not found'), { status: 404 });

  const tmdbId = Number(meta.moviedb_id);
  if (!Number.isFinite(tmdbId) || tmdbId <= 0) {
    throw Object.assign(new Error('this title has no TMDB id, so playback cannot resolve'), { status: 422 });
  }

  const released = String(meta.released ?? '').slice(0, 10);
  const year = Number(meta.year) || Number(released.slice(0, 4)) || null;
  const runtimeMinutes = (() => {
    if (Number.isFinite(Number(meta.runtime))) return Number(meta.runtime);
    const match = /(\d+)\s*(?:min|m)\b/i.exec(String(meta.runtime ?? ''));
    return match ? Number(match[1]) : null;
  })();

  return {
    tmdbId,
    imdbId,
    title: String(meta.name ?? '').trim(),
    year,
    release: released || (year ? `${year}-01-01` : '1970-01-01'),
    runtime: runtimeMinutes ? runtimeMinutes * 60 : null,
    rating: Number.isFinite(Number(meta.imdbRating)) ? Number(meta.imdbRating) : null,
    genres: Array.isArray(meta.genres) ? meta.genres : [],
    overview: String(meta.description ?? ''),
    poster: meta.poster || posterFor(imdbId),
    backdrop: meta.background || backdropFor(imdbId),
    featured: false,
  };
}
