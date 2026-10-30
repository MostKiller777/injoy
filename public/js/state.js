import {
  deleteWatchlist,
  getProgressAll,
  getWatchlist,
  postProgress,
  putWatchlist,
} from './api.js';

const LS = {
  list: 'injoy.watchlist.v1',
  progress: 'injoy.progress.v1',
  recent: 'injoy.recent.v1',
  prefs: 'injoy.prefs.v1',
};

// Older builds wrote under the previous brand. Copy across once so a rename
// never costs anybody their watchlist or resume points.
const LEGACY_LS = {
  list: 'ollflix.watchlist.v1',
  progress: 'ollflix.progress.v1',
  recent: 'ollflix.recent.v1',
  prefs: 'ollflix.prefs.v1',
};

function migrateLegacyKeys() {
  try {
    for (const [key, legacy] of Object.entries(LEGACY_LS)) {
      if (localStorage.getItem(LS[key]) === null && localStorage.getItem(legacy) !== null) {
        localStorage.setItem(LS[key], localStorage.getItem(legacy));
      }
    }
  } catch {
    /* private mode — nothing to migrate */
  }
}

const listeners = new Set();
export const state = {
  watchlist: new Map(),
  progress: {},
  recent: [],
  prefs: {
    muted: false,
    volume: 1,
    captionSize: 'middle',
    captionOffset: 0,
    captionOffsets: {},
    captionScales: {},
  },
  ready: false,
};

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(reason) {
  for (const fn of listeners) {
    try {
      fn(reason, state);
    } catch (err) {
      console.warn('[state] listener failed', err);
    }
  }
}

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode / quota — the in-memory copy still works */
  }
}

const persistList = () => write(LS.list, [...state.watchlist.values()]);
const persistProgress = () => write(LS.progress, state.progress);
const persistRecent = () => write(LS.recent, state.recent);
const persistPrefs = () => write(LS.prefs, state.prefs);

const isCatalogId = (id) => /^(?:tmdb|tv):/.test(String(id ?? ''));

export function loadLocal() {
  migrateLegacyKeys();
  for (const item of read(LS.list, [])) {
    if (isCatalogId(item?.id)) state.watchlist.set(item.id, item);
  }
  state.progress = read(LS.progress, {});
  state.recent = read(LS.recent, []).filter((item) => isCatalogId(item?.id));
  state.prefs = { ...state.prefs, ...read(LS.prefs, {}) };
  emit('local');
}

export async function syncLibrary() {
  const [remoteList, remoteProgress] = await Promise.allSettled([getWatchlist(), getProgressAll()]);

  if (remoteList.status === 'fulfilled') {
    for (const item of remoteList.value.items ?? []) {
      if (isCatalogId(item?.id) && !state.watchlist.has(item.id)) state.watchlist.set(item.id, item);
    }
    persistList();
  }

  if (remoteProgress.status === 'fulfilled') {
    for (const [id, entry] of Object.entries(remoteProgress.value.progress ?? {})) {
      const local = state.progress[id];
      if (!local || (entry.updatedAt ?? 0) > (local.updatedAt ?? 0)) state.progress[id] = entry;
    }
    persistProgress();
  }

  state.ready = true;
  emit('sync');

  // Push anything the server has not seen yet. Failures are non-fatal.
  const remoteIds = new Set((remoteList.value?.items ?? []).map((item) => item.id));
  for (const item of state.watchlist.values()) {
    if (!remoteIds.has(item.id)) putWatchlist(item).catch(() => {});
  }
  const remoteProgressIds = new Set(Object.keys(remoteProgress.value?.progress ?? {}));
  for (const [id, entry] of Object.entries(state.progress)) {
    if (!remoteProgressIds.has(id)) postProgress(id, entry.t, entry.d).catch(() => {});
  }
}

export const inList = (id) => state.watchlist.has(id);

export function mini(item) {
  return {
    id: item.id,
    source: item.source,
    title: item.title,
    year: item.year ?? null,
    poster: item.poster ?? null,
    backdrop: item.backdrop ?? null,
    rating: item.rating ?? null,
    runtime: item.runtime ?? null,
    overview: item.overview ?? '',
    genres: item.genres ?? [],
    tmdbId: item.tmdbId ?? null,
    kind: item.kind ?? 'film',
    seasons: item.seasons ?? null,
    episodes: item.episodes ?? null,
  };
}

export async function toggleList(item) {
  if (!item?.id) return { added: false };
  if (state.watchlist.has(item.id)) {
    state.watchlist.delete(item.id);
    persistList();
    emit('list');
    deleteWatchlist(item.id).catch(() => {});
    return { added: false };
  }

  state.watchlist.set(item.id, { ...mini(item), addedAt: Date.now() });
  persistList();
  emit('list');
  putWatchlist(item).catch(() => {});
  return { added: true };
}

export const listItems = () =>
  [...state.watchlist.values()]
    .filter((item) => isCatalogId(item.id))
    .sort((a, b) => (b.addedAt ?? 0) - (a.addedAt ?? 0));

export function rememberShown(item) {
  if (!item?.id) return;
  state.recent = [mini(item), ...state.recent.filter((entry) => entry.id !== item.id)].slice(0, 24);
  persistRecent();
}

export function recentItems() {
  return state.recent
    .filter((item) => isCatalogId(item.id))
    .map((item) => ({ item, entry: state.progress[item.id] }))
    .filter(({ entry }) => entry && entry.t > 20);
}

export function progressFor(id) {
  const entry = state.progress[id];
  if (!entry || !entry.t) return null;
  return entry;
}

/**
 * Episode a show should resume at.
 *
 * Looks at every saved episode of the series and continues the most recently
 * watched one — unless it was finished, in which case it moves to the next
 * episode in broadcast order. A show with no history starts at the top. Used by
 * the autoplay path so opening a series never asks which episode or source.
 */
export function nextUpEpisode(detail) {
  const seasons = detail?.seasons ?? [];
  const flat = [];
  for (const season of seasons) {
    for (const episode of season.episodes ?? []) {
      flat.push({ ...episode, season: season.number });
    }
  }
  if (!flat.length) return null;

  let lastIndex = -1;
  let lastAt = -1;
  flat.forEach((episode, index) => {
    const entry = state.progress[`${detail.id}:${episode.season}:${episode.number}`];
    if (!entry?.t) return;
    const at = entry.updatedAt ?? 0;
    if (at >= lastAt) {
      lastAt = at;
      lastIndex = index;
    }
  });

  if (lastIndex === -1) return flat[0];

  const watched = flat[lastIndex];
  const entry = state.progress[`${detail.id}:${watched.season}:${watched.number}`];
  const finished = entry?.d && entry.t >= entry.d - 60;
  if (finished && lastIndex + 1 < flat.length) return flat[lastIndex + 1];
  return watched;
}

export function setLocalProgress(id, t, d) {
  if (!id || !Number.isFinite(t)) return;
  state.progress[id] = { t: Math.round(t), d: d ? Math.round(d) : null, updatedAt: Date.now() };
  persistProgress();
}

export function saveProgress(id, t, d) {
  setLocalProgress(id, t, d);
  if (t < 10) return;
  postProgress(id, Math.round(t), d ? Math.round(d) : 0).catch(() => {});
}

export function clearProgress(id) {
  delete state.progress[id];
  persistProgress();
}

export function setVolume(volume, muted) {
  state.prefs.volume = Math.min(1, Math.max(0, volume));
  state.prefs.muted = Boolean(muted);
  persistPrefs();
}

/** Caption text size, one of `small`, `middle`, `big`. Kept with the volume. */
export const CAPTION_SIZES = ['small', 'middle', 'big'];

export function setCaptionSize(size) {
  state.prefs.captionSize = CAPTION_SIZES.includes(size) ? size : 'middle';
  persistPrefs();
}

/**
 * Caption sync, in seconds.
 *
 * Index subtitles are timed for one specific release, so the cues can land a
 * beat early or late on the copy being played. The value is kept with the size
 * and applied by shifting every cue of the showing track.
 */
export function setCaptionOffset(offset) {
  return setCaptionOffsetFor(null, offset);
}

/** Return the saved sync for one title/language, falling back to old global data. */
export function captionOffsetFor(key) {
  const stored = key ? state.prefs.captionOffsets?.[key] : undefined;
  return Number.isFinite(Number(stored))
    ? Number(stored)
    : Number(state.prefs.captionOffset) || 0;
}

/**
 * Store sync per title and language.
 *
 * A single global offset made one badly timed episode poison every other title.
 * The old `captionOffset` remains as the migration fallback; new adjustments
 * live under `<play id>:<language>` instead.
 */
export function setCaptionOffsetFor(key, offset) {
  const value = Number(offset);
  const normalized = Number.isFinite(value) ? Math.max(-30, Math.min(30, Math.round(value * 10) / 10)) : 0;
  if (key) {
    state.prefs.captionOffsets = { ...(state.prefs.captionOffsets ?? {}), [key]: normalized };
  } else {
    state.prefs.captionOffset = normalized;
  }
  persistPrefs();
  return normalized;
}

/**
 * Caption speed, per title and language.
 *
 * A constant offset fixes a track that starts late; it cannot fix a track that
 * drifts. A subtitle timed for a 25 fps master played against a 23.976 fps copy
 * falls a little further behind every minute, and by the end the gap is over
 * four percent of the runtime. The scale stretches every cue around zero so the
 * last line lands where the first line said it would.
 */
export function captionScaleFor(key) {
  const stored = key ? state.prefs.captionScales?.[key] : undefined;
  const value = Number(stored);
  return Number.isFinite(value) && value > 0.8 && value < 1.25 ? value : 1;
}

export function setCaptionScaleFor(key, scale) {
  const value = Number(scale);
  const normalized = Number.isFinite(value)
    ? Math.max(0.8, Math.min(1.25, Math.round(value * 1000) / 1000))
    : 1;
  if (key) {
    state.prefs.captionScales = { ...(state.prefs.captionScales ?? {}), [key]: normalized };
  }
  persistPrefs();
  return normalized;
}

export function continueCount() {
  return recentItems().length;
}
