import * as tmdb from './tmdb.js';
import { embedSources } from './providers.js';
import { imgProxy } from './images.js';
import { CURATED_ITEMS, curatedDetail, curatedFeatured, curatedSearch } from './curated.js';
import { seriesDetail, seriesItems, seriesSearch, seriesSources } from './series.js';
import { dashSession } from './dashstore.js';
import { mediaFor } from './media.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export const TTL = {
  home: 10 * MINUTE,
  search: 5 * MINUTE,
  detail: 30 * MINUTE,
};

/**
 * The shelf is curated-only. Each genre maps to the TMDB genre names carried by
 * the catalog records; Noir is a local tag because TMDB has no noir genre.
 */
const GENRES = [
  { id: 'noir', name: 'Noir', match: ['Noir'] },
  { id: 'horror', name: 'Horror', match: ['Horror'] },
  { id: 'scifi', name: 'Sci-Fi', match: ['Science Fiction'] },
  { id: 'comedy', name: 'Comedy', match: ['Comedy'] },
  { id: 'drama', name: 'Drama', match: ['Drama'] },
  { id: 'western', name: 'Western', match: ['Western'] },
  { id: 'animation', name: 'Animation', match: ['Animation'] },
  { id: 'documentary', name: 'Documentary', match: ['Documentary'] },
];

const GENRE_SUBS = {
  noir: 'rain-slick streets, bad decisions, worse people',
  horror: 'lights off, volume up',
  scifi: 'the future, the void, the machine',
  comedy: 'press play, breathe out',
  drama: 'the heavy ones, the ones that stay',
  western: 'dust, blood and a long ride home',
  animation: 'drawn, painted, impossible',
  documentary: 'true stories that outrun fiction',
};

const PAGE_SIZE = 36;

export function tmdbToItem(movie) {
  if (!movie?.id) return null;
  const date = movie.release_date || movie.first_air_date || '';
  return {
    id: `tmdb:${movie.id}`,
    source: 'tmdb',
    tmdbId: movie.id,
    title: movie.title || movie.name || movie.original_title || 'Untitled',
    originalTitle: movie.original_title ?? null,
    year: Number.parseInt(date.slice(0, 4), 10) || null,
    overview: movie.overview || '',
    rating: Number.isFinite(movie.vote_average) && movie.vote_average > 0
      ? Number(movie.vote_average.toFixed(1))
      : null,
    votes: movie.vote_count ?? null,
    poster: imgProxy(tmdb.image(movie.poster_path, 'w500')),
    backdrop: imgProxy(tmdb.image(movie.backdrop_path, 'w1280')),
    popularity: movie.popularity ?? 0,
    genres: Array.isArray(movie.genres) ? movie.genres.map((genre) => genre.name) : [],
    genreIds: movie.genre_ids ?? [],
    badge: 'HD',
    sources: embedSources(movie.id),
  };
}

async function settle(promise, fallback) {
  try {
    return await promise;
  } catch (err) {
    console.warn(`[catalog] ${err.message}`);
    return fallback;
  }
}

function dedupe(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    if (!item || seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

function inGenre(item, genre) {
  return (item.genres ?? []).some((name) => genre.match.includes(name));
}

function byRating(a, b) {
  return (b.rating ?? 0) - (a.rating ?? 0) || (b.votes ?? 0) - (a.votes ?? 0);
}

export async function home() {
  const rows = [];

  const newest = CURATED_ITEMS.slice(0, 20);
  if (newest.length) {
    rows.push({
      key: 'newest',
      title: 'Newest releases',
      sub: 'the modern shelf — pick one and press play',
      items: newest,
      layout: 'poster',
      tag: 'New',
    });
  }

  const featured = curatedFeatured();
  if (featured.length) {
    rows.push({
      key: 'featured',
      title: "Editor's pick",
      sub: 'interstellar, dune, oppenheimer — the big-screen ones',
      items: featured,
      layout: 'poster',
      tag: 'Featured',
    });
  }

  const shows = seriesItems();
  const pinned = shows.find((show) => show.title === 'The Mentalist');
  const ordered = pinned ? [pinned, ...shows.filter((show) => show.id !== pinned.id)] : shows;
  if (ordered.length) {
    rows.push({
      key: 'series',
      title: 'Series',
      sub: 'full seasons, episode by episode — the mentalist leads the shelf',
      items: ordered.slice(0, 20),
      layout: 'poster',
      tag: 'Series',
    });
  }

  for (const genre of GENRES) {
    const items = [...CURATED_ITEMS].filter((item) => inGenre(item, genre)).sort(byRating).slice(0, 24);
    if (!items.length) continue;
    rows.push({
      key: `genre-${genre.id}`,
      title: genre.name,
      sub: GENRE_SUBS[genre.id] ?? null,
      items,
      layout: 'poster',
    });
  }

  return {
    hero: featured[0] ?? newest[0] ?? null,
    rows,
    mode: 'curated',
    generatedAt: new Date().toISOString(),
  };
}

function sanitizeQuery(input) {
  return String(input ?? '')
    .replace(/[\\"':()[\]{}^~*?!+|&]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

const searchKey = (value) => String(value ?? '')
  .toLowerCase()
  .replace(/[^a-z0-9 ]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

export async function searchTitles(query, page = 1) {
  const clean = sanitizeQuery(query);
  if (!clean) return { page, totalPages: 0, items: [], mode: 'curated' };
  const term = searchKey(clean);
  const films = page === 1 ? curatedSearch(clean) : [];
  const shows = page === 1 ? seriesSearch(clean) : [];

  // Films and series score in separate lists, so re-rank the merged set on how
  // close the title is to what was typed — otherwise "mentalist" buries the
  // show under whatever the film scorer liked best.
  const rank = (item) => {
    const title = searchKey(item.title);
    if (title === term) return 0;
    if (title.startsWith(term)) return 1;
    if (title.includes(term)) return 2;
    return 3;
  };
  const items = dedupe([...films, ...shows])
    .map((item, index) => ({ item, index }))
    .sort((a, b) => rank(a.item) - rank(b.item)
      || (b.item.rating ?? 0) - (a.item.rating ?? 0)
      || a.index - b.index)
    .map((entry) => entry.item);

  return { page, totalPages: 1, items, mode: 'curated' };
}

export async function browse({ page = 1, genre = '', sort = 'popular' } = {}) {
  const config = GENRES.find((entry) => entry.id === genre) ?? null;
  let items = config ? CURATED_ITEMS.filter((item) => inGenre(item, config)) : [...CURATED_ITEMS];

  switch (sort) {
    case 'rating':
      items.sort(byRating);
      break;
    case 'newest':
      items.sort((a, b) => String(b.release ?? '').localeCompare(String(a.release ?? '')));
      break;
    case 'oldest':
      items.sort((a, b) => String(a.release ?? '').localeCompare(String(b.release ?? '')));
      break;
    default:
      items.sort(byRating);
  }

  const safePage = Math.max(1, Math.min(page, Math.max(1, Math.ceil(items.length / PAGE_SIZE))));
  const start = (safePage - 1) * PAGE_SIZE;
  return {
    page: safePage,
    totalPages: Math.max(1, Math.ceil(items.length / PAGE_SIZE)),
    total: items.length,
    items: dedupe(items.slice(start, start + PAGE_SIZE)),
    mode: 'curated',
  };
}

export async function genres() {
  return {
    genres: GENRES.map((genre) => ({
      id: genre.id,
      name: genre.name,
      count: CURATED_ITEMS.filter((item) => inGenre(item, genre)).length,
    })),
    mode: 'curated',
  };
}

function trailerFrom(videos) {
  const list = videos?.results ?? [];
  const pick =
    list.find((video) => video.site === 'YouTube' && video.type === 'Trailer' && video.official) ??
    list.find((video) => video.site === 'YouTube' && video.type === 'Trailer') ??
    list.find((video) => video.site === 'YouTube');
  return pick ? { key: pick.key, name: pick.name, url: `https://www.youtube.com/watch?v=${pick.key}` } : null;
}

export async function detail(id) {
  const [kind, raw] = String(id).split(':', 2);
  if (kind === 'tv' && raw) {
    const series = seriesDetail(String(id));
    if (series) return series;
    throw Object.assign(new Error('not found'), { status: 404 });
  }
  if (kind !== 'tmdb' || !raw) throw Object.assign(new Error('not found'), { status: 404 });

  const local = curatedDetail(raw);
  if (!tmdb.tmdbEnabled()) {
    if (local) return local;
    throw Object.assign(new Error('not found'), { status: 404 });
  }

  const data = await settle(tmdb.detail(raw), null);
  if (!data?.id) {
    if (local) return local;
    throw Object.assign(new Error('not found'), { status: 404 });
  }

  const item = tmdbToItem(data);
  const similar = dedupe([
    ...(data.similar?.results ?? []).map(tmdbToItem),
    ...(data.recommendations?.results ?? []).map(tmdbToItem),
  ].filter(Boolean)).slice(0, 20);

  const crew = data.credits?.crew ?? [];
  const directors = crew.filter((person) => person.job === 'Director').map((person) => person.name);

  return {
    ...item,
    runtime: data.runtime ?? null,
    tagline: data.tagline || null,
    status: data.status || null,
    releaseDate: data.release_date || null,
    genres: (data.genres ?? []).map((genre) => genre.name),
    votes: data.vote_count ?? null,
    rating: data.vote_average ? Number(data.vote_average.toFixed(1)) : null,
    production: (data.production_companies ?? []).slice(0, 3).map((company) => company.name),
    directors,
    cast: (data.credits?.cast ?? []).slice(0, 12).map((person) => ({
      name: person.name,
      character: person.character,
      photo: imgProxy(tmdb.image(person.profile_path, 'w185')),
    })),
    trailer: trailerFrom(data.videos),
    sources: embedSources(data.id),
    similar,
    badge: 'HD',
    stream: null,
  };
}

export async function sources(id) {
  const [kind, raw] = String(id).split(':', 2);

  // A downloaded copy always wins: it seeks, it resumes, it needs no embed.
  const local = mediaFor(id);
  let localSource = [];

  if (local?.kind === 'dash') {
    const session = await dashSession(id);
    if (session) {
      localSource = [{
        provider: 'local',
        label: 'Downloaded',
        kind: 'direct',
        quality: session.video.height ? `${session.video.height}p` : 'source',
        container: 'dash',
        session,
        duration: session.duration ?? null,
        url: `local-dash:${id}`,
      }];
    }
  } else if (local) {
    localSource = [{
      provider: 'local',
      label: 'Downloaded',
      kind: 'direct',
      quality: 'source',
      url: `/api/stream/${encodeURIComponent(id)}`,
      bytes: local.bytes,
      container: local.ext,
      duration: local.duration ?? null,
    }];
  }

  if (kind === 'tv' && raw) {
    const data = seriesSources(id);
    if (data) return { id, sources: [...localSource, ...data.sources] };
    throw Object.assign(new Error('not found'), { status: 404 });
  }
  if (kind !== 'tmdb' || !raw) throw Object.assign(new Error('not found'), { status: 404 });
  return { id, sources: [...localSource, ...embedSources(raw)] };
}

/** The series page: every show, best-rated first, films excluded. */
export async function seriesShelf() {
  return { items: seriesItems(), total: seriesItems().length, mode: 'curated' };
}

export async function randomPick() {
  if (!CURATED_ITEMS.length) return null;
  return CURATED_ITEMS[Math.floor(Math.random() * CURATED_ITEMS.length)];
}
