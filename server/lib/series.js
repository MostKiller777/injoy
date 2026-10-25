import { imgProxy } from './images.js';
import { SERIES_DATA } from './series-data.js';
import { tmdbForImdb } from './tmdb-ids.js';

/**
 * Series shelf. Same contract as the film shelves: frozen metadata, ids in a
 * namespaced id (`tv:<tvmazeId>`), and sources resolved per episode. TVMaze is
 * the source because it carries the episode list without a key; the episode
 * embeds key off the IMDb id TVMaze hands over.
 */
const TITLE_FIX = {
  MINDHUNTER: 'Mindhunter',
  'Arcane: League of Legends': 'Arcane',
  Cosmos: 'Cosmos: A Spacetime Odyssey',
};

const EPISODE_PROVIDERS = [
  {
    id: 'vidsrc.to',
    label: 'VidSrc',
    url: (imdb, season, episode) => `https://vidsrc.to/embed/tv?imdb=${imdb}&season=${season}&episode=${episode}`,
  },
  {
    id: 'vidsrc.xyz',
    label: 'VidSrc XYZ',
    url: (imdb, season, episode) => `https://vidsrc.xyz/embed/tv?imdb=${imdb}&season=${season}&episode=${episode}`,
  },
  {
    id: '2embed',
    label: '2Embed',
    url: (imdb, season, episode) => `https://www.2embed.cc/embedtv/${imdb}&s=${season}&e=${episode}`,
    ads: true,
  },
  {
    id: 'superembed',
    label: 'SuperEmbed',
    url: (imdb, season, episode) => `https://multiembed.mov/directstream.php?video_id=${imdb}&tmdb=0&s=${season}&e=${episode}`,
    ads: true,
  },
];

const art = (url) => (url ? imgProxy(url) : null);

const totalEpisodes = (show) => show.seasons.reduce((sum, season) => sum + season.episodes.length, 0);

export function episodeSources(show, season = 1, episode = 1) {
  if (!show?.imdbId) return [];
  // Ad-heavy hosts go last so the episode opens on a clean player first.
  const ordered = [...EPISODE_PROVIDERS].sort((a, b) => Number(a.ads ?? false) - Number(b.ads ?? false));
  return ordered.map((provider) => ({
    provider: provider.id,
    label: provider.ads ? `${provider.label} · ads` : provider.label,
    kind: 'embed',
    quality: 'auto',
    url: provider.url(show.imdbId, season, episode),
  }));
}

function normalize(show) {
  const title = TITLE_FIX[show.title] ?? show.title;
  return {
    id: `tv:${show.tvmazeId}`,
    source: 'tvmaze',
    sourceKind: 'series',
    kind: 'series',
    tvmazeId: show.tvmazeId,
    imdbId: show.imdbId,
    title,
    originalTitle: null,
    year: show.year,
    release: `${show.year}-01-01`,
    overview: show.overview,
    rating: show.rating ?? null,
    votes: null,
    popularity: 0,
    genres: show.genres ?? [],
    genreIds: [],
    runtime: show.runtime ? show.runtime * 60 : null,
    poster: art(show.posterUrl),
    backdrop: art(show.backdropUrl),
    badge: 'Series',
    seasons: show.seasons.length,
    episodes: totalEpisodes(show),
    network: show.network,
    status: show.status,
    endYear: show.endYear,
    sources: episodeSources(show, 1, 1),
  };
}

const ITEMS = SERIES_DATA.map(normalize);
const BY_ID = new Map(ITEMS.map((item) => [item.id, item]));
const BY_TVMAZE = new Map(SERIES_DATA.map((show) => [String(show.tvmazeId), show]));

export function seriesItems() {
  return [...ITEMS].sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));
}

export function seriesCount() {
  return ITEMS.length;
}

export function isSeries(id) {
  return BY_ID.has(String(id));
}

export function seriesDetail(id) {
  const key = String(id);
  const item = BY_ID.get(key);
  const show = BY_TVMAZE.get(key.slice(3));
  if (!item || !show) return null;

  const similar = seriesItems()
    .filter((other) => other.id !== item.id)
    .sort((a, b) => {
      const overlap = (entry) => (entry.genres ?? []).filter((genre) => item.genres.includes(genre)).length;
      return overlap(b) - overlap(a) || (b.rating ?? 0) - (a.rating ?? 0);
    })
    .slice(0, 12);

  return {
    ...item,
    releaseDate: `${item.year}-01-01`,
    tagline: null,
    production: item.network ? [item.network] : [],
    directors: [],
    creator: null,
    cast: [],
    trailer: null,
    seasons: show.seasons.map((season) => ({
      number: season.number,
      episodes: season.episodes.map((episode) => ({
        number: episode.number,
        name: episode.name,
        airdate: episode.airdate,
        runtime: episode.runtime ? episode.runtime * 60 : null,
        summary: episode.summary,
        playId: `${item.id}:${season.number}:${episode.number}`,
      })),
    })),
    sources: episodeSources(show, 1, 1),
    similar,
    stream: null,
  };
}

export function seriesSources(id) {
  const [kind, raw, season, episode] = String(id).split(':');
  if (kind !== 'tv' || !raw) return null;
  const show = BY_TVMAZE.get(raw);
  if (!show) return null;
  const s = Number(season) || 1;
  const e = Number(episode) || 1;
  return { id, sources: episodeSources(show, s, e) };
}

/**
 * What the stream resolver needs to find an episode: a TMDB id (the working
 * provider keys on it), the IMDb id as a fallback, and the episode coordinates.
 */
export function seriesStreamTarget(id) {
  const [kind, raw, season, episode] = String(id).split(':');
  if (kind !== 'tv' || !raw) return null;
  const show = BY_TVMAZE.get(raw);
  if (!show) return null;
  return {
    imdbId: show.imdbId ?? null,
    tmdbId: tmdbForImdb(show.imdbId),
    season: Number(season) || 1,
    episode: Number(episode) || 1,
    title: show.title,
  };
}

const normalizeName = (value) => String(value ?? '')
  .toLowerCase()
  .replace(/[^a-z0-9 ]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

export function seriesSearch(query) {
  const term = normalizeName(query);
  if (!term) return [];
  const words = term.split(' ').filter(Boolean);
  const stem = term.slice(0, 5);
  const scored = [];
  for (const item of ITEMS) {
    const haystack = normalizeName([item.title, item.network, String(item.year), ...(item.genres ?? [])].join(' '));
    if (haystack.includes(term)) scored.push({ item, score: 100 + term.length });
    else if (words.every((word) => haystack.includes(word))) scored.push({ item, score: 80 + words.length });
    else if (stem.length >= 4 && haystack.includes(stem)) scored.push({ item, score: 40 + stem.length });
  }
  return scored.sort((a, b) => b.score - a.score || (b.item.rating ?? 0) - (a.item.rating ?? 0)).map((entry) => entry.item);
}
