import {
  adminAdd,
  adminCustom,
  adminRemove,
  adminSearch,
  getBrowse,
  getDetail,
  getGenres,
  getHome,
  getRandom,
  getSearch,
  getSeries,
  invalidateCatalog,
} from './api.js';
import {
  continueCount,
  listItems,
  loadLocal,
  nextUpEpisode,
  recentItems,
  subscribe,
  syncLibrary,
} from './state.js';
import * as ui from './ui.js';
import { el } from './ui.js';

// The player pulls in the DASH/HLS feeders and every control. None of that is
// needed to paint the catalogue, so it is loaded on the first play instead of
// on the first visit. The service worker caches it after that.
let playerModule = null;
function openPlayer(item) {
  playerModule ??= import('./player.js');
  return playerModule
    .then((module) => module.openPlayer(item))
    .catch((err) => {
      console.error('[player] failed to load', err);
      ui.toast('The player failed to load', 'warn');
      return null;
    });
}

const view = document.getElementById('view');
const hero = document.getElementById('hero');
const searchForm = document.getElementById('search-form');
const searchInput = document.getElementById('search-input');
const randomButton = document.getElementById('random-btn');
const topbar = document.getElementById('topbar');
const footerMode = document.getElementById('footer-mode');

let baseRoute = '#/';
let routeAbort = null;
let lastDetailId = null;
let genresCache = null;
let searchTimer = null;
let booted = false;

/* -------------------------------- handlers ------------------------------- */

/**
 * Hand a series straight to the player.
 *
 * Resumes the last watched episode (or starts at S1E1), and the player picks
 * the first working source itself — opening a show never asks for an episode
 * or a provider first.
 */
function playSeries(detail) {
  const episode = nextUpEpisode(detail);
  if (!episode) {
    ui.toast('This series has no episodes yet', 'warn');
    return false;
  }
  openPlayer({
    ...detail,
    playId: `${detail.id}:${episode.season}:${episode.number}`,
    title: `${detail.title} — S${episode.season}E${episode.number} · ${episode.name}`,
  });
  return true;
}

const handlers = {
  onOpen: (item) => {
    location.hash = `#/movie/${encodeURIComponent(item.id)}`;
  },
  onPlay: (item) => {
    if (item.kind === 'series') {
      getDetail(item.id).then((detail) => playSeries(detail)).catch(() => openPlayer(item));
      return;
    }
    openPlayer(item);
  },
};

const detailHandlers = {
  onPlay: (detail) => {
    restoreBase();
    if (detail.kind === 'series' && !detail.playId) {
      playSeries(detail);
      return;
    }
    openPlayer(detail);
  },
  onLoaded: (detail) => {
    // Opening a show is a play intent: start it, leave the panel underneath.
    if (detail.kind !== 'series') return;
    if (document.getElementById('player-root')?.childElementCount) return;
    playSeries(detail);
  },
  onClose: () => {
    lastDetailId = null;
    restoreBase();
  },
  replace: (id) => {
    history.replaceState(null, '', `#/movie/${encodeURIComponent(id)}`);
    lastDetailId = id;
    ui.openDetail(id, detailHandlers);
  },
};

function restoreBase() {
  if (location.hash.startsWith('#/movie/')) {
    history.replaceState(null, '', baseRoute || '#/');
  }
}

/* --------------------------------- router -------------------------------- */

function route() {
  const hash = location.hash || '#/';

  if (hash.startsWith('#/movie/')) {
    const id = decodeURIComponent(hash.slice('#/movie/'.length));
    if (!view.childElementCount) {
      renderHome()
        .catch(() => {})
        .finally(() => openDetailRoute(id));
      return;
    }
    openDetailRoute(id);
    return;
  }

  // A dedicated series page: every season expanded, no player over the top.
  // The detail sheet auto-plays a show, so this is the place to browse all 151
  // episodes without the video covering the list.
  if (hash.startsWith('#/show/')) {
    const id = decodeURIComponent(hash.slice('#/show/'.length));
    baseRoute = hash;
    lastDetailId = null;
    routeAbort?.abort();
    const controller = new AbortController();
    routeAbort = controller;
    ui.closeDetail();
    window.scrollTo(0, 0);
    setActiveNav('/series');
    return renderShow(id, controller.signal);
  }

  baseRoute = hash;
  lastDetailId = null;
  routeAbort?.abort();
  const controller = new AbortController();
  routeAbort = controller;

  ui.closeDetail();
  window.scrollTo(0, 0);

  const [path, query] = hash.slice(1).split('?');
  const params = new URLSearchParams(query ?? '');
  setActiveNav(path);

  const titles = { '/films': 'Films', '/series': 'Series', '/genres': 'Genres', '/list': 'My list', '/search': 'Search', '/admin': 'Admin' };
  document.title = path === '/search' && params.get('q')
    ? `${params.get('q')} — Injoy`
    : `${titles[path] ?? 'Watch everything'} — Injoy`;

  if (path === '/search') {
    const term = params.get('q') ?? '';
    if (document.activeElement !== searchInput) searchInput.value = term;
  } else if (document.activeElement !== searchInput) {
    searchInput.value = '';
  }

  if (path === '/films') return renderFilms(params, controller.signal);
  if (path === '/series') return renderSeries(controller.signal);
  if (path === '/genres') return renderGenres(controller.signal);
  if (path === '/list') return renderList();
  if (path === '/search') return renderSearch(params.get('q') ?? '', controller.signal);
  if (path === '/admin') return renderAdmin(controller.signal);
  return renderHome(controller.signal);
}

function openDetailRoute(id) {
  if (lastDetailId === id) return;
  lastDetailId = id;
  ui.openDetail(id, detailHandlers);
}

function setActiveNav(path) {
  const key = path === '/films' ? 'films'
    : path === '/series' ? 'series'
    : path === '/genres' ? 'genres'
    : path === '/list' ? 'list'
    : 'home';
  document.querySelectorAll('.primary-nav a').forEach((link) => {
    link.classList.toggle('is-active', link.dataset.nav === key);
    if (link.dataset.nav === key) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
}

/* --------------------------------- home ---------------------------------- */

async function renderHome(signal) {
  setActiveNav('/');
  ui.homeSkeleton();
  try {
    const data = await getHome(signal);
    if (signal?.aborted) return;

    hero.hidden = false;
    ui.renderHero(data.hero, handlers);

    const fragment = document.createDocumentFragment();
    if (continueCount()) {
      fragment.append(ui.rail({
        key: 'continue',
        title: 'Continue watching',
        sub: 'picked up where you left off',
        items: recentItems().map((entry) => entry.item),
      }, handlers));
    }
    for (const row of data.rows) fragment.append(ui.rail(row, handlers));

    fragment.append(el('div', { class: 'state', style: { paddingTop: '20px' } },
      el('p', { text: 'Every film here is hand-picked; playback uses a local copy when available, otherwise a public embed.' }),
    ));

    ui.clear(view).append(fragment);
    if (footerMode) footerMode.textContent = 'curated catalog';
  } catch (err) {
    if (signal?.aborted) return;
    hero.hidden = true;
    ui.clear(view).append(ui.emptyState({
      title: 'The projector jammed',
      message: err.message,
      actionLabel: 'Try again',
      onAction: () => renderHome(),
    }));
  }
}

/* --------------------------------- films --------------------------------- */

function pageHead(title, subtitle, tools = []) {
  return el('div', { class: 'page-head' },
    el('div', {},
      el('h1', { text: title }),
      subtitle ? el('p', { text: subtitle }) : null,
    ),
    el('div', { class: 'page-tools' }, ...tools),
  );
}

async function renderFilms(params, signal) {
  hero.hidden = true;
  ui.clear(view);

  const genre = params.get('genre') ?? '';
  const sort = params.get('sort') ?? 'popular';

  const genreSelect = el('select', { class: 'select', 'aria-label': 'Filter by genre' },
    el('option', { value: '', text: 'All genres' }),
  );
  const sortSelect = el('select', { class: 'select', 'aria-label': 'Sort' },
    el('option', { value: 'popular', text: 'Most popular' }),
    el('option', { value: 'rating', text: 'Highest rated' }),
    el('option', { value: 'newest', text: 'Newest first' }),
    el('option', { value: 'oldest', text: 'Oldest first' }),
  );
  sortSelect.value = sort;

  const head = pageHead('Every film', 'A hand-picked shelf — noir, horror, sci-fi, comedy, drama, western, animation, documentary.', [genreSelect, sortSelect]);
  view.append(head);

  const grid = el('div', { class: 'grid' });
  const sentinel = el('div', { class: 'state', style: { padding: '24px' } });
  view.append(grid, sentinel);

  const navigate = (nextGenre, nextSort) => {
    const next = new URLSearchParams();
    if (nextGenre) next.set('genre', nextGenre);
    if (nextSort && nextSort !== 'popular') next.set('sort', nextSort);
    const suffix = next.toString();
    history.pushState(null, '', `#/films${suffix ? `?${suffix}` : ''}`);
    route();
  };

  genreSelect.addEventListener('change', () => navigate(genreSelect.value, sortSelect.value));
  sortSelect.addEventListener('change', () => navigate(genreSelect.value, sortSelect.value));

  getGenres()
    .then((data) => {
      genresCache = data.genres ?? [];
      if (signal.aborted) return;
      for (const item of genresCache) {
        genreSelect.append(el('option', { value: item.id, text: item.name }));
      }
      genreSelect.value = genre;
    })
    .catch(() => {});

  pagedGrid({
    grid,
    sentinel,
    signal,
    load: (page) => getBrowse({ page, genre, sort }, signal),
  });
}

/* -------------------------------- series --------------------------------- */

async function renderSeries(signal) {
  hero.hidden = true;
  ui.clear(view);
  view.append(pageHead(
    'Every series',
    'Full seasons, episode by episode — dramas, comedies, sci-fi, crime and the odd documentary.',
  ));

  const grid = el('div', { class: 'grid' });
  const note = el('div', { class: 'state', style: { padding: '24px' } },
    el('div', { class: 'spinner' }),
  );
  view.append(grid, note);

  try {
    const data = await getSeries(signal);
    if (signal?.aborted) return;
    const items = data.items ?? [];
    for (const item of items) grid.append(ui.gridCard(item, handlers));
    note.replaceChildren(el('p', { text: `${items.length} series · ${items.reduce((sum, show) => sum + (show.episodes ?? 0), 0).toLocaleString()} episodes` }));
  } catch (err) {
    if (signal?.aborted) return;
    note.replaceChildren(ui.emptyState({ title: 'No series', message: err.message }));
  }
}

/* ------------------------------ series page ------------------------------ */

/**
 * Every season, expanded.
 *
 * Opening a show from a card is a play intent: the detail sheet fetches, then
 * the player covers it. That is right for watching, wrong for browsing. This
 * route is the browse view — all seasons, all episodes, no autoplay, no iframe
 * over the list.
 */
async function renderShow(id, signal) {
  hero.hidden = true;
  ui.clear(view);
  view.append(el('div', { class: 'state', style: { padding: '70px 24px' } }, el('div', { class: 'spinner' })));

  let detail;
  try {
    detail = await getDetail(id);
  } catch (err) {
    if (signal?.aborted) return;
    view.replaceChildren(ui.emptyState({
      title: 'Could not load this series',
      message: err.message,
      actionLabel: 'Back to series',
      onAction: () => { location.hash = '#/series'; },
    }));
    return;
  }
  if (signal?.aborted) return;

  const seasons = Array.isArray(detail.seasons) ? detail.seasons : [];
  const total = seasons.reduce((sum, season) => sum + season.episodes.length, 0);
  const first = seasons[0]?.episodes[0] ?? null;

  const play = (episode, season) => {
    openPlayer({
      ...detail,
      playId: episode.playId,
      title: `${detail.title} — S${season.number}E${episode.number} · ${episode.name}`,
    });
  };

  document.title = `${detail.title} — Injoy`;

  const facts = [
    detail.year ? String(detail.year) : null,
    detail.rating ? `${detail.rating.toFixed(1)} / 10` : null,
    seasons.length ? `${seasons.length} seasons` : null,
    total ? `${total} episodes` : null,
  ].filter(Boolean);

  const head = el('section', { class: 'show-head' },
    detail.poster
      ? el('img', { class: 'show-poster', src: detail.poster, alt: '', loading: 'eager', referrerpolicy: 'no-referrer' })
      : el('div', { class: 'show-poster show-poster-empty', text: ui.initials(detail.title) }),
    el('div', { class: 'show-info' },
      el('a', { class: 'show-back', href: '#/series', text: '← All series' }),
      el('h1', { text: detail.title }),
      el('div', { class: 'show-meta' }, ...facts.map((fact) => el('span', { text: fact }))),
      detail.overview ? el('p', { class: 'show-overview', text: detail.overview }) : null,
      el('div', { class: 'show-actions' },
        first ? el('button', {
          class: 'btn btn-primary', type: 'button',
          on: { click: () => play(first, seasons[0]) },
        }, ui.icon('play'), el('span', { text: `Play S1E1` })) : null,
        el('a', { class: 'btn btn-ghost', href: '#/series', text: 'Series shelf' }),
      ),
    ),
  );

  const jumps = seasons.length > 1
    ? el('nav', { class: 'show-jumps', 'aria-label': 'Jump to season' },
        ...seasons.map((season) => el('button', {
          class: 'show-jump', type: 'button',
          on: {
            click: () => document.getElementById(`season-${season.number}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
          },
        }, `Season ${season.number}`)))
    : null;

  const sections = seasons.map((season) => el('section', {
    class: 'show-season', id: `season-${season.number}`,
  },
    el('div', { class: 'show-season-head' },
      el('h2', { class: 'show-season-title', text: `Season ${season.number}` }),
      el('span', { class: 'show-season-sub', text: `${season.episodes.length} episodes` }),
    ),
    el('div', { class: 'episode-list show-episode-list' },
      ...season.episodes.map((episode) => {
        const meta = [
          episode.airdate ?? null,
          episode.runtime ? `${Math.round(episode.runtime / 60)} min` : null,
        ].filter(Boolean).join(' · ');
        return el('button', {
          class: 'episode', type: 'button',
          'aria-label': `Play season ${season.number} episode ${episode.number}, ${episode.name}`,
          on: { click: () => play(episode, season) },
        },
          el('span', { class: 'episode-num', text: String(episode.number).padStart(2, '0') }),
          el('span', { class: 'episode-body' },
            el('span', { class: 'episode-name', text: episode.name }),
            meta ? el('span', { class: 'episode-meta', text: meta }) : null,
            episode.summary ? el('span', { class: 'episode-summary', text: episode.summary }) : null,
          ),
          el('span', { class: 'episode-play', 'aria-hidden': 'true', text: '▶' }),
        );
      }),
    ),
  ));

  view.replaceChildren(
    head,
    jumps,
    ...(sections.length ? sections : [ui.emptyState({ title: 'No episodes', message: 'This series has no episode list yet.' })]),
  );
}

/* --------------------------------- admin --------------------------------- */

/**
 * Type a movie name, pick the right result, press Add.
 *
 * The server does the rest: Cinemeta metadata, a custom-films.json record, a
 * catalogue rebuild and a cache clear. No restart, no code edit. The small key
 * field is for a public host that sets ADMIN_KEY; localhost does not need it.
 */
async function renderAdmin(signal) {
  hero.hidden = true;
  ui.clear(view);

  const keyInput = el('input', {
    class: 'admin-key', type: 'password', autocomplete: 'off', spellcheck: 'false',
    placeholder: 'Admin key — only if the server sets ADMIN_KEY',
    value: localStorage.getItem('injoy.adminKey') ?? '',
    'aria-label': 'Admin key',
  });
  keyInput.addEventListener('input', () => {
    const key = keyInput.value.trim();
    if (key) localStorage.setItem('injoy.adminKey', key);
    else localStorage.removeItem('injoy.adminKey');
  });
  keyInput.addEventListener('change', () => { void loadCustom(); });

  const query = el('input', {
    class: 'admin-search', type: 'search', spellcheck: 'false',
    placeholder: 'Type a movie name…', 'aria-label': 'Movie name',
  });
  const submit = el('button', { class: 'btn btn-primary', type: 'submit' }, 'Search');
  const form = el('form', { class: 'admin-search-form' }, query, submit);
  const status = el('p', { class: 'admin-status' });
  const results = el('div', { class: 'admin-results' });
  const customList = el('div', { class: 'admin-custom' });

  const key = () => keyInput.value.trim();
  const setStatus = (text, href = null, label = null) => {
    status.replaceChildren(el('span', { text }));
    if (href) {
      status.append(
        el('a', { class: 'admin-status-link', href, text: label ?? 'Open' }),
      );
    }
  };

  const addFilm = async (item, button) => {
    button.disabled = true;
    button.textContent = 'Adding…';
    setStatus(`Adding “${item.title}”…`);
    try {
      const data = await adminAdd(item.imdbId, key());
      invalidateCatalog();
      await loadCustom();
      if (data.already) {
        setStatus(`“${item.title}” is already in the catalogue.`, `#/movie/${encodeURIComponent(data.item.id)}`, 'Open it');
      } else {
        setStatus(`“${item.title}” added.`, `#/movie/${encodeURIComponent(data.item.id)}`, 'Watch it');
        ui.toast(`Added ${item.title}`);
      }
      if (data.item) button.textContent = data.already ? 'In catalogue' : 'Added';
      else button.textContent = 'Add';
    } catch (err) {
      setStatus(err.status === 401
        ? 'Admin key required. Set ADMIN_KEY on the server and paste it above.'
        : `Could not add: ${err.message}`);
      button.disabled = false;
      button.textContent = 'Add';
    }
  };

  const renderResults = (items) => {
    results.replaceChildren();
    if (!items.length) {
      setStatus('No match. Try a shorter title or the year.');
      return;
    }
    for (const item of items) {
      const button = el('button', {
        class: 'btn btn-primary btn-mini', type: 'button',
      }, 'Add');
      button.addEventListener('click', () => { void addFilm(item, button); });
      results.append(el('article', { class: 'admin-result' },
        item.poster ? el('img', { class: 'admin-result-poster', src: item.poster, alt: '', loading: 'lazy' }) : null,
        el('div', { class: 'admin-result-info' },
          el('h3', { text: item.title }),
          el('p', { class: 'admin-result-meta', text: [item.year, item.rating ? `${item.rating} / 10` : null].filter(Boolean).join(' · ') || '—' }),
          item.overview ? el('p', { class: 'admin-result-overview', text: item.overview }) : null,
        ),
        button,
      ));
    }
  };

  const runSearch = async () => {
    const term = query.value.trim();
    if (term.length < 2) {
      setStatus('Type at least two characters.');
      return;
    }
    submit.disabled = true;
    setStatus(`Searching for “${term}”…`);
    results.replaceChildren();
    try {
      const data = await adminSearch(term, key());
      if (signal?.aborted) return;
      renderResults(data.results ?? []);
      if (data.results?.length) setStatus(`${data.results.length} results — pick the film, then Add.`);
    } catch (err) {
      if (signal?.aborted) return;
      setStatus(err.status === 401
        ? 'Admin key required. Set ADMIN_KEY on the server and paste it above.'
        : `Search failed: ${err.message}`);
    } finally {
      submit.disabled = false;
    }
  };

  async function loadCustom() {
    try {
      const data = await adminCustom(key());
      if (signal?.aborted) return;
      const items = data.items ?? [];
      customList.replaceChildren();
      if (!items.length) {
        customList.append(el('p', { class: 'admin-empty', text: 'No custom films yet. Search above and press Add.' }));
        return;
      }
      for (const item of items) {
        const remove = el('button', { class: 'btn btn-ghost btn-mini', type: 'button' }, 'Remove');
        remove.addEventListener('click', async () => {
          remove.disabled = true;
          try {
            await adminRemove(item.tmdbId, key());
            invalidateCatalog();
            await loadCustom();
            setStatus(`Removed “${item.title}”.`);
            ui.toast(`Removed ${item.title}`);
          } catch (err) {
            setStatus(err.status === 401 ? 'Admin key required.' : `Could not remove: ${err.message}`);
            remove.disabled = false;
          }
        });
        customList.append(el('div', { class: 'admin-row' },
          item.poster ? el('img', { class: 'admin-row-poster', src: item.poster, alt: '', loading: 'lazy' }) : null,
          el('div', { class: 'admin-row-info' },
            el('strong', { text: item.title }),
            el('span', { text: `${item.year ?? '—'} · ${item.id}` }),
          ),
          el('div', { class: 'admin-row-actions' },
            el('a', { class: 'btn btn-ghost btn-mini', href: `#/movie/${encodeURIComponent(item.id)}`, text: 'Open' }),
            remove,
          ),
        ));
      }
    } catch (err) {
      if (signal?.aborted) return;
      customList.replaceChildren(el('p', { class: 'admin-empty', text: err.status === 401 ? 'Admin key required to list custom films.' : `Could not load custom films: ${err.message}` }));
    }
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void runSearch();
  });

  view.append(
    pageHead('Admin', 'Type a movie name. The server finds it, adds it, and reloads the catalogue instantly.'),
    el('div', { class: 'admin-key-row' },
      el('span', { class: 'admin-key-label', text: 'Admin key' }),
      keyInput,
    ),
    form,
    status,
    results,
    el('h2', { class: 'admin-section-title', text: 'Custom films' }),
    customList,
    el('p', { class: 'admin-foot', text: 'Entries are stored in data/custom-films.json. Removing one here removes it from the catalogue.' }),
  );

  query.focus();
  void loadCustom();
}

/* -------------------------------- genres --------------------------------- */

async function renderGenres(signal) {
  hero.hidden = true;
  ui.clear(view);
  view.append(pageHead('Genres', 'Pick a mood. The shelf rearranges itself.'));

  const container = el('div', { class: 'genre-grid' });
  view.append(container);

  for (let i = 0; i < 12; i += 1) {
    container.append(el('div', { class: 'skeleton', style: { height: '104px', borderRadius: '16px' } }));
  }

  try {
    if (!genresCache) genresCache = (await getGenres()).genres ?? [];
    if (signal?.aborted) return;
    ui.clear(container);
    for (const genre of genresCache) {
      container.append(el('a', {
        class: 'genre-tile',
        href: `#/films?genre=${encodeURIComponent(genre.id)}`,
        text: genre.name,
      }));
    }
  } catch (err) {
    ui.clear(container).append(ui.emptyState({ title: 'No genres', message: err.message }));
  }
}

/* --------------------------------- search -------------------------------- */

async function renderSearch(query, signal) {
  hero.hidden = true;
  const term = query.trim();
  ui.clear(view);

  if (!term) {
    view.append(
      pageHead('Search', 'Titles, directors, decades, vibes.'),
      ui.emptyState({
        title: 'What are you watching tonight?',
        message: 'Try “Interstellar”, “noir”, “Nolan”, “1954”, or a title you half remember.',
      }),
    );
    return;
  }

  view.append(pageHead(`“${term}”`, 'results'));

  const grid = el('div', { class: 'grid' });
  const sentinel = el('div', { class: 'state', style: { padding: '24px' } });
  view.append(grid, sentinel);

  pagedGrid({
    grid,
    sentinel,
    signal,
    load: (page) => getSearch(term, page, signal),
    emptyTitle: `Nothing matched “${term}”`,
    emptyMessage: 'Spelling, a shorter phrase, or a different decade usually finds it.',
    emptyAction: { label: 'Back to home', action: () => { location.hash = '#/'; } },
  });
}

/* ------------------------------- grid paging ----------------------------- */

function pagedGrid({ grid, sentinel, load, signal, emptyTitle, emptyMessage, emptyAction }) {
  let page = 0;
  let loading = false;
  let done = false;

  const placeholders = [];
  for (let i = 0; i < 12; i += 1) {
    placeholders.push(el('div', { class: 'grid-skeleton skeleton' }));
  }
  grid.append(...placeholders);
  const dropPlaceholders = () => {
    while (placeholders.length) placeholders.pop().remove();
  };

  const more = async () => {
    if (loading || done) return;
    loading = true;
    if (page > 0) sentinel.replaceChildren(el('div', { class: 'spinner' }));

    try {
      const data = await load(page + 1);
      if (signal?.aborted) return;
      page += 1;
      dropPlaceholders();

      for (const item of data.items ?? []) {
        grid.append(ui.gridCard(item, handlers));
      }

      if (page === 1 && !(data.items ?? []).length) {
        done = true;
        sentinel.replaceChildren(ui.emptyState({
          title: emptyTitle ?? 'Empty shelf',
          message: emptyMessage,
          actionLabel: emptyAction?.label,
          onAction: emptyAction?.action,
        }));
        return;
      }

      if (page >= (data.totalPages ?? page) || page >= 20) {
        done = true;
        sentinel.replaceChildren();
      } else if (page === 1) {
        sentinel.replaceChildren(el('div', { class: 'state', style: { padding: '10px' } },
          el('button', { class: 'btn btn-ghost btn-mini', type: 'button', on: { click: more } }, 'Load more')));
      } else {
        sentinel.replaceChildren();
      }
    } catch (err) {
      if (signal?.aborted) return;
      dropPlaceholders();
      sentinel.replaceChildren(ui.emptyState({
        title: 'Could not load more',
        message: err.message,
        actionLabel: 'Retry',
        onAction: () => {
          loading = false;
          more();
        },
      }));
    } finally {
      loading = false;
    }
  };

  const stop = ui.observeSentinel(sentinel, more);
  more();
  return stop;
}

/* ---------------------------------- list --------------------------------- */

function renderList() {
  hero.hidden = true;
  ui.clear(view);

  const items = listItems();
  const continueRow = recentItems();

  view.append(pageHead('My list', `${items.length} saved · ${continueRow.length} in progress`));

  if (items.length === 0) {
    view.append(ui.emptyState({
      title: 'Your list is empty',
      message: 'Hit the + on any card and it lands here, on every device that talks to this server.',
      actionLabel: 'Find something',
      onAction: () => { location.hash = '#/films'; },
    }));
    return;
  }

  if (continueRow.length) {
    view.append(ui.rail({
      key: 'continue-list',
      title: 'Continue watching',
      items: continueRow.map((entry) => entry.item),
    }, handlers));
  }

  view.append(ui.buildGrid(items, handlers));
}

/* --------------------------------- boot ---------------------------------- */

function onSearchSubmit(event) {
  event.preventDefault();
  const value = searchInput.value.trim();
  if (!value) {
    location.hash = '#/';
    return;
  }
  const next = `#/search?q=${encodeURIComponent(value)}`;
  if (location.hash === next) route();
  else location.hash = next;
  searchInput.blur();
}

function onSearchInput() {
  clearTimeout(searchTimer);
  const value = searchInput.value.trim();
  searchTimer = setTimeout(() => {
    if (value.length === 0) {
      if (location.hash.startsWith('#/search')) {
        history.replaceState(null, '', '#/');
        route();
      }
      return;
    }
    if (value.length < 2) return;
    history.replaceState(null, '', `#/search?q=${encodeURIComponent(value)}`);
    route();
  }, 420);
}

async function surpriseMe() {
  randomButton.classList.add('is-busy');
  try {
    const { item } = await getRandom();
    if (item) location.hash = `#/movie/${encodeURIComponent(item.id)}`;
  } catch (err) {
    ui.toast(err.message, 'err');
  } finally {
    randomButton.classList.remove('is-busy');
  }
}

function globalKeys(event) {
  const typing = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement;

  if (event.key === '/' && !typing) {
    event.preventDefault();
    searchInput.focus();
    searchInput.select();
    return;
  }
  if (event.key.toLowerCase() === 'r' && !typing && !event.metaKey && !event.ctrlKey) {
    event.preventDefault();
    surpriseMe();
    return;
  }
  if (event.key === 'Escape' && document.activeElement === searchInput) {
    searchInput.value = '';
    searchInput.blur();
    if (location.hash.startsWith('#/search')) {
      history.replaceState(null, '', '#/');
      route();
    }
  }
}

async function boot() {
  if (booted) return;
  booted = true;

  loadLocal();
  subscribe((reason) => {
    if (reason === 'list' || reason === 'sync') {
      if (location.hash.startsWith('#/list')) renderList();
    }
  });

  document.getElementById('search-form').addEventListener('submit', onSearchSubmit);
  searchInput.addEventListener('input', onSearchInput);
  randomButton.addEventListener('click', surpriseMe);
  document.addEventListener('keydown', globalKeys);

  window.addEventListener('hashchange', route);
  window.addEventListener('scroll', () => {
    topbar.classList.toggle('is-stuck', window.scrollY > 14);
  }, { passive: true });
  topbar.classList.toggle('is-stuck', window.scrollY > 14);

  route();

  syncLibrary().catch(() => {});

  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
}

boot();
