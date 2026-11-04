import {
  adminAdd,
  adminCustom,
  adminLogin,
  adminLogout,
  adminRemove,
  adminSearch,
  adminAiSave,
  adminAiStatus,
  adminSession,
  agentChat,
  agentDiagnose,
  agentFix,
  codeApply,
  codeChat,
  codeReject,
  getAnalytics,
  trackVisit,
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

const ADMIN_CHAT_KEY = 'injoy.adminChat.v1';
const CODE_CHAT_KEY = 'injoy.codeChat.v1';

function readStored(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeStored(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // private mode or quota — the in-memory chat still works
  }
}

function dropStored(key) {
  try {
    localStorage.removeItem(key);
  } catch {
    // nothing to clear
  }
}

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
  // The document loads once; every navigation after that is a hash change the
  // server never sees unless the page says so. Sent for browsing paths only —
  // an admin screen is not a visit.
  if (!hash.startsWith('#/admin')) {
    const path = hash.split('?')[0].slice(0, 120);
    trackVisit(path).catch(() => {});
  }

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
  if (path === '/admin/code') return renderCodeAgent(controller.signal);
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

/** Gate the panel behind the HttpOnly session cookie. */
async function renderAdmin(signal) {
  hero.hidden = true;
  ui.clear(view);

  let session = { authenticated: false, ai: false, model: null, baseUrl: null, source: null };
  try {
    session = await adminSession();
  } catch {
    // Server unreachable: show the login so the user can retry.
  }
  if (signal?.aborted) return;
  if (session.authenticated) renderAdminPanel(signal, session);
  else renderAdminLogin(signal);
}

function renderAdminLogin(signal, afterLogin = () => renderAdmin(signal)) {
  const password = el('input', {
    class: 'admin-login-input',
    type: 'password',
    placeholder: 'Admin password',
    autocomplete: 'current-password',
    'aria-label': 'Admin password',
  });
  const button = el('button', { class: 'btn btn-primary', type: 'submit' }, 'Unlock');
  const form = el('form', { class: 'admin-login-form' }, password, button);
  const status = el('p', { class: 'admin-status' });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!password.value) {
      status.textContent = 'Enter the admin password.';
      return;
    }
    button.disabled = true;
    status.textContent = 'Checking…';
    try {
      await adminLogin(password.value);
      if (signal?.aborted) return;
      password.value = '';
      await afterLogin();
    } catch (err) {
      status.textContent = err.status === 401 ? 'Wrong password.' : `Could not sign in: ${err.message}`;
      password.select();
    } finally {
      button.disabled = false;
    }
  });

  view.append(
    pageHead('Admin', 'Private panel. Sign in to add films.'),
    el('div', { class: 'admin-login-card' },
      el('p', { class: 'admin-login-copy' },
        'The password is set by ',
        el('code', { text: 'ADMIN_KEY' }),
        ' in ',
        el('code', { text: '.env' }),
        '. Without it, a generated key lives in ',
        el('code', { text: 'data/admin-key.txt' }),
        ' on this machine, or ',
        el('code', { text: '/var/lib/injoy/admin-key.txt' }),
        ' on a host.'),
      form,
      status,
      el('p', { class: 'admin-foot', text: 'The session lasts 24 hours. Closing the browser or pressing Lock signs out.' }),
    ),
  );
  password.focus();
}

/**
 * Type a movie name, pick the right result, press Add.
 *
 * The server does the rest: Cinemeta metadata, a custom-films.json record, a
 * catalogue rebuild and a cache clear. No restart, no code edit.
 */
async function renderAdminPanel(signal, session = {}) {
  const query = el('input', {
    class: 'admin-search', type: 'search', spellcheck: 'false',
    placeholder: 'Type a movie name…', 'aria-label': 'Movie name',
  });
  const submit = el('button', { class: 'btn btn-primary', type: 'submit' }, 'Search');
  const form = el('form', { class: 'admin-search-form' }, query, submit);
  const status = el('p', { class: 'admin-status' });
  const results = el('div', { class: 'admin-results' });
  const customList = el('div', { class: 'admin-custom' });

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
      const data = await adminAdd(item.imdbId);
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
      if (err.status === 401) {
        renderAdmin();
        return;
      }
      setStatus(`Could not add: ${err.message}`);
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
      const data = await adminSearch(term);
      if (signal?.aborted) return;
      renderResults(data.results ?? []);
      if (data.results?.length) setStatus(`${data.results.length} results — pick the film, then Add.`);
    } catch (err) {
      if (signal?.aborted) return;
      if (err.status === 401) {
        renderAdmin();
        return;
      }
      setStatus(`Search failed: ${err.message}`);
    } finally {
      submit.disabled = false;
    }
  };

  async function loadCustom() {
    try {
      const data = await adminCustom();
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
            await adminRemove(item.tmdbId);
            invalidateCatalog();
            await loadCustom();
            setStatus(`Removed “${item.title}”.`);
            ui.toast(`Removed ${item.title}`);
          } catch (err) {
            if (err.status === 401) {
              renderAdmin();
              return;
            }
            setStatus(`Could not remove: ${err.message}`);
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
      if (err.status === 401) {
        renderAdmin();
        return;
      }
      customList.replaceChildren(el('p', { class: 'admin-empty', text: `Could not load custom films: ${err.message}` }));
    }
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void runSearch();
  });

  const lock = el('button', {
    class: 'btn btn-ghost btn-mini',
    type: 'button',
    on: {
      click: async () => {
        try { await adminLogout(); } catch { /* the cookie is gone either way */ }
        renderAdmin();
      },
    },
  }, 'Lock');

  const codeLink = el('a', { class: 'btn btn-ghost btn-mini', href: '#/admin/code', text: 'Code agent' });

  /* ------------------------------ analytics ------------------------------- */

  const trafficRanges = [
    { days: 1, label: 'Today' },
    { days: 7, label: '7 days' },
    { days: 30, label: '30 days' },
  ];
  let trafficDays = 1;

  const trafficKpis = el('div', { class: 'traffic-kpis' });
  const trafficChart = el('div', { class: 'traffic-chart' });
  const trafficCountries = el('div', { class: 'traffic-list' });
  const trafficTitles = el('div', { class: 'traffic-list' });
  const trafficSources = el('div', { class: 'traffic-list' });
  const trafficNote = el('p', { class: 'admin-foot', text: 'Counted on the server: one row per visit, address salted and hashed, never stored.' });
  const rangeButtons = trafficRanges.map((entry) => {
    const button = el('button', {
      class: `traffic-range${entry.days === 1 ? ' is-on' : ''}`,
      type: 'button',
      on: {
        click: () => {
          trafficDays = entry.days;
          for (const node of rangeButtons) node.classList.toggle('is-on', node === button);
          void loadTraffic();
        },
      },
    }, entry.label);
    return button;
  });

  const barList = (target, rows, { empty = 'Nothing yet.' } = {}) => {
    target.replaceChildren();
    if (!rows.length) {
      target.append(el('p', { class: 'traffic-empty', text: empty }));
      return;
    }
    const peak = Math.max(...rows.map((row) => row.count), 1);
    for (const row of rows) {
      const value = row.share === undefined ? String(row.count) : `${row.count} · ${row.share}%`;
      target.append(el('div', { class: 'traffic-row' },
        el('span', { class: 'traffic-row-name', text: row.name, title: row.name }),
        el('span', { class: 'traffic-row-bar' },
          el('span', { class: 'traffic-row-fill', style: `width:${Math.max(4, Math.round((row.count / peak) * 100))}%` }),
        ),
        el('span', { class: 'traffic-row-value', text: value }),
      ));
    }
  };

  const kpi = (label, value, sub) => el('div', { class: 'traffic-kpi' },
    el('span', { class: 'traffic-kpi-label', text: label }),
    el('strong', { class: 'traffic-kpi-value', text: String(value) }),
    sub ? el('span', { class: 'traffic-kpi-sub', text: sub }) : null,
  );

  const paintTraffic = (data) => {
    const { today, range } = data;
    const perVisitor = range.visitors ? (range.plays / range.visitors).toFixed(1) : '0.0';

    trafficKpis.replaceChildren(
      kpi('Visitors today', today.visitors, today.date),
      kpi('Page views today', today.views, 'today'),
      kpi('Plays today', today.plays, 'titles started'),
      kpi(`Visitors · ${data.span === 1 ? 'today' : `${data.span} days`}`, range.visitors, `${perVisitor} plays each`),
    );

    const series = data.timeline.slice(-14);
    const peak = Math.max(...series.map((day) => day.visitors), 1);
    trafficChart.replaceChildren(...series.map((day) => el('div', { class: 'traffic-bar', title: `${day.date} · ${day.visitors} visitors · ${day.views} views` },
      el('span', {
        class: 'traffic-bar-fill',
        style: `height:${Math.max(3, Math.round((day.visitors / peak) * 100))}%`,
      }),
      el('span', { class: 'traffic-bar-label', text: day.date.slice(5) }),
    )));

    barList(trafficCountries, range.countries.map((row) => ({
      name: row.name,
      count: row.count,
      share: row.share,
    })), { empty: 'No countries recorded yet.' });

    barList(trafficTitles, range.titles.map((row) => ({ name: row.name, count: row.count })), { empty: 'No plays yet.' });

    const sources = [
      ...range.referrers.map((row) => ({ name: row.name, count: row.count })),
      ...range.devices.map((row) => ({ name: `${row.name} devices`, count: row.count })),
    ];
    barList(trafficSources, sources, { empty: 'No referrers yet.' });
  };

  const loadTraffic = async () => {
    try {
      const data = await getAnalytics(trafficDays, signal);
      if (signal?.aborted) return;
      paintTraffic(data);
    } catch (err) {
      if (err.status === 401) { renderAdmin(); return; }
      trafficKpis.replaceChildren(el('p', { class: 'traffic-empty', text: `Could not load traffic: ${err.message}` }));
    }
  };

  /* ------------------------------- doctor -------------------------------- */

  let doctorReport = null;
  const doctorSummary = el('p', { class: 'doctor-summary', text: 'Not checked yet.' });
  const doctorList = el('div', { class: 'doctor-list' });
  const runButton = el('button', { class: 'btn btn-primary btn-mini', type: 'button' }, 'Run diagnosis');
  const fixAllButton = el('button', { class: 'btn btn-ghost btn-mini', type: 'button', disabled: '' }, 'Fix everything fixable');
  const copyButton = el('button', { class: 'btn btn-ghost btn-mini', type: 'button' }, 'Copy report');

  const renderDoctor = (data) => {
    doctorReport = data;
    const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
    doctorSummary.textContent = `${plural(data.summary.total, 'check')} · ${data.summary.ok} ok · ${plural(data.summary.warn, 'warning')} · ${plural(data.summary.fail, 'failure')} · ${data.summary.fixable} fixable`;
    doctorList.replaceChildren(...data.checks.map((check) => {
      const fix = check.fixable && check.status !== 'ok'
        ? el('button', {
            class: 'btn btn-ghost btn-mini doctor-fix',
            type: 'button',
            on: {
              click: (event) => {
                event.currentTarget.disabled = true;
                void fixOne(check.id);
              },
            },
          }, 'Fix')
        : null;
      return el('div', { class: `doctor-row doctor-${check.status}` },
        el('span', { class: 'doctor-status', text: check.status }),
        el('div', { class: 'doctor-body' },
          el('strong', { text: check.label }),
          el('p', { text: check.detail }),
        ),
        fix,
      );
    }));
    fixAllButton.disabled = data.summary.fixable === 0;
  };

  const fixOne = async (id) => {
    try {
      const result = await agentFix([id]);
      invalidateCatalog();
      await loadCustom();
      renderDoctor(result.diagnosis);
      ui.toast(`Fixed ${id}`);
    } catch (err) {
      if (err.status === 401) { renderAdmin(); return; }
      doctorSummary.textContent = `Repair failed: ${err.message}`;
    }
  };

  const fixAll = async () => {
    fixAllButton.disabled = true;
    fixAllButton.textContent = 'Fixing…';
    try {
      const result = await agentFix([]);
      invalidateCatalog();
      await loadCustom();
      renderDoctor(result.diagnosis);
      ui.toast(result.fixed.length ? `Fixed ${result.fixed.length} issue(s)` : 'Nothing needed fixing');
    } catch (err) {
      if (err.status === 401) { renderAdmin(); return; }
      doctorSummary.textContent = `Repair failed: ${err.message}`;
    } finally {
      fixAllButton.textContent = 'Fix everything fixable';
      fixAllButton.disabled = !doctorReport || doctorReport.summary.fixable === 0;
    }
  };

  const runDoctor = async () => {
    runButton.disabled = true;
    runButton.textContent = 'Checking…';
    doctorSummary.textContent = 'Checking server, catalogue, data files, images, captions and network…';
    doctorList.replaceChildren();
    try {
      const data = await agentDiagnose();
      if (signal?.aborted) return;
      renderDoctor(data);
    } catch (err) {
      if (signal?.aborted) return;
      if (err.status === 401) { renderAdmin(); return; }
      doctorSummary.textContent = `Diagnosis failed: ${err.message}`;
      fixAllButton.disabled = true;
    } finally {
      runButton.disabled = false;
      runButton.textContent = 'Run diagnosis';
    }
  };

  runButton.addEventListener('click', () => { void runDoctor(); });
  fixAllButton.addEventListener('click', () => { void fixAll(); });
  copyButton.addEventListener('click', async () => {
    if (!doctorReport) {
      ui.toast('Run a diagnosis first', 'warn');
      return;
    }
    try {
      await navigator.clipboard.writeText(JSON.stringify(doctorReport, null, 2));
      ui.toast('Report copied');
    } catch {
      ui.toast('Clipboard is blocked in this browser', 'warn');
    }
  });

  /* -------------------------------- chat --------------------------------- */

  const chatMessages = el('div', { class: 'agent-messages', role: 'log', 'aria-live': 'polite' });
  const chatInput = el('input', {
    class: 'agent-input',
    type: 'text',
    placeholder: 'Ask the agent…',
    autocomplete: 'off',
    spellcheck: 'false',
    'aria-label': 'Message the agent',
  });
  const chatSend = el('button', { class: 'btn btn-primary btn-mini', type: 'submit' }, 'Send');
  const chatForm = el('form', { class: 'agent-form' }, chatInput, chatSend);
  const chatChips = el('div', { class: 'agent-suggestions' });
  const savedChat = readStored(ADMIN_CHAT_KEY, null);
  let chatContext = savedChat?.context && typeof savedChat.context === 'object' ? savedChat.context : {};
  let chatLog = Array.isArray(savedChat?.messages) ? savedChat.messages.slice(-60) : [];
  let chatHistory = chatLog
    .filter((entry) => entry.role === 'user' || entry.role === 'assistant')
    .slice(-12)
    .map((entry) => ({ role: entry.role, content: entry.text }));
  const persistChat = () => writeStored(ADMIN_CHAT_KEY, {
    messages: chatLog.slice(-60),
    context: chatContext,
    updatedAt: Date.now(),
  });
  const WELCOME = 'I can check and fix the site, add or remove films, show stats, logs and backups. What do you need?';
  let aiEnabled = Boolean(session.ai);
  let aiModel = session.model ?? null;
  let aiSource = session.source ?? 'none';
  const aiBadge = el('span', { class: 'agent-badge' });
  const chatSub = el('p', { class: 'agent-chat-sub' });
  const aiSummary = el('summary', {});

  const paintAi = () => {
    aiBadge.textContent = aiEnabled ? `AI · ${aiModel ?? 'model'}` : 'Built-in agent';
    aiBadge.classList.toggle('is-ai', aiEnabled);
    chatSub.textContent = aiEnabled
      ? 'Model-driven agent with site tools. Ask it to check, fix, add, remove or explain.'
      : 'Built-in agent: stats, doctor, fix, logs, backups, add and remove films. No key needed.';
    aiSummary.textContent = aiEnabled ? `Optional model · ${aiModel ?? 'active'}` : 'Optional model · none';
  };
  paintAi();

  const aiBaseInput = el('input', {
    class: 'admin-ai-field', type: 'text', spellcheck: 'false',
    value: session.baseUrl ?? 'https://api.openai.com/v1',
    'aria-label': 'AI base URL',
  });
  const aiModelInput = el('input', {
    class: 'admin-ai-field', type: 'text', spellcheck: 'false',
    value: aiModel ?? 'gpt-4o-mini',
    'aria-label': 'AI model',
  });
  const aiKeyInput = el('input', {
    class: 'admin-ai-field', type: 'password', autocomplete: 'off',
    placeholder: 'Paste an API key — leave blank to keep the saved one',
    'aria-label': 'AI API key',
  });
  const aiStatusText = el('p', {
    class: 'admin-ai-status',
    text: aiSource === 'env'
      ? 'Using AI_API_KEY from the environment.'
      : aiEnabled ? 'Model configured.' : 'No model. The built-in agent handles every command above.',
  });
  const aiSaveButton = el('button', { class: 'btn btn-primary btn-mini', type: 'submit' }, 'Save settings');
  const aiForm = el('form', { class: 'admin-ai-form' },
    el('label', { class: 'admin-ai-label' }, el('span', { text: 'Base URL' }), aiBaseInput),
    el('label', { class: 'admin-ai-label' }, el('span', { text: 'Model' }), aiModelInput),
    el('label', { class: 'admin-ai-label' }, el('span', { text: 'API key' }), aiKeyInput),
    el('div', { class: 'admin-ai-actions' }, aiSaveButton, aiStatusText),
  );

  aiForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    aiSaveButton.disabled = true;
    aiStatusText.textContent = 'Saving…';
    try {
      const status = await adminAiSave({
        apiKey: aiKeyInput.value,
        baseUrl: aiBaseInput.value,
        model: aiModelInput.value,
      });
      aiEnabled = Boolean(status.configured);
      aiModel = status.model;
      aiSource = status.source;
      aiKeyInput.value = '';
      paintAi();
      aiStatusText.textContent = status.configured
        ? `AI active (${status.model})${status.source === 'env' ? ' using environment key' : ''}.`
        : 'Saved. Add an API key to activate the model.';
      ui.toast(status.configured ? 'AI agent enabled' : 'AI settings saved');
    } catch (err) {
      if (err.status === 401) { renderAdmin(); return; }
      aiStatusText.textContent = `Could not save: ${err.message}`;
    } finally {
      aiSaveButton.disabled = false;
    }
  });

  void adminAiStatus().then((status) => {
    if (signal?.aborted) return;
    aiEnabled = Boolean(status.configured);
    aiModel = status.model;
    aiSource = status.source;
    if (!aiBaseInput.value) aiBaseInput.value = status.baseUrl;
    if (!aiModelInput.value) aiModelInput.value = status.model;
    if (status.source === 'env') aiStatusText.textContent = 'Using AI_API_KEY from the environment.';
    else if (status.configured) aiStatusText.textContent = 'AI key saved.';
    paintAi();
  }).catch(() => { /* settings are optional */ });

  const appendMessage = (role, text, link = null, { record = true } = {}) => {
    const bubble = el('div', { class: 'agent-bubble' }, el('span', { text: String(text ?? '') }));
    if (link) bubble.append(' ', el('a', { class: 'agent-link', href: link, text: 'Open' }));
    const row = el('div', { class: `agent-msg ${role}` }, bubble);
    chatMessages.append(row);
    chatMessages.scrollTop = chatMessages.scrollHeight;
    if (record) {
      chatLog.push({ role, text: String(text ?? '').slice(0, 8_000), link: link ?? null });
      chatLog = chatLog.slice(-60);
      persistChat();
    }
    return row;
  };

  const clearChat = () => {
    dropStored(ADMIN_CHAT_KEY);
    chatLog = [];
    chatHistory = [];
    chatContext = {};
    chatMessages.replaceChildren();
    appendMessage('agent', WELCOME, null, { record: false });
    ui.toast('Chat cleared');
  };

  const sendAgent = async (text) => {
    const message = String(text ?? chatInput.value).trim();
    if (!message) return;
    appendMessage('user', message);
    chatInput.value = '';
    chatSend.disabled = true;
    const thinking = appendMessage('agent', 'Working…', null, { record: false });
    try {
      const data = await agentChat(message, chatContext, chatHistory);
      chatContext = data.context ?? {};
      persistChat();
      thinking.remove();
      appendMessage('agent', data.reply ?? 'Done.', data.link ?? null);
      chatHistory = chatLog
        .filter((entry) => entry.role === 'user' || entry.role === 'assistant')
        .slice(-12)
        .map((entry) => ({ role: entry.role, content: entry.text }));
      if (data.warning) appendMessage('agent', data.warning, null, { record: false });
      if (data.refresh) {
        invalidateCatalog();
        await loadCustom();
        void runDoctor();
      }
    } catch (err) {
      thinking.remove();
      if (err.status === 401) { renderAdmin(); return; }
      appendMessage('agent', `Error: ${err.message}`, null, { record: false });
    } finally {
      chatSend.disabled = false;
      chatInput.focus();
    }
  };

  chatForm.addEventListener('submit', (event) => {
    event.preventDefault();
    void sendAgent();
  });

  for (const label of ['Check the site', 'Fix everything', 'Stats', 'Search The Matrix', 'Custom films', 'Logs', 'Help']) {
    chatChips.append(el('button', {
      class: 'agent-chip', type: 'button',
      on: { click: () => { void sendAgent(label); } },
    }, label));
  }

  if (chatLog.length) {
    for (const entry of chatLog) {
      if (entry?.role === 'user' || entry?.role === 'agent') {
        appendMessage(entry.role, entry.text, entry.link ?? null, { record: false });
      }
    }
  } else {
    appendMessage('agent', WELCOME, null, { record: false });
  }

  view.append(
    pageHead('Admin', 'Chat with the agent, add films, and run the site doctor.', [codeLink, lock]),
    el('div', { class: 'admin-dashboard' },
      el('section', { class: 'admin-card agent-chat-card' },
        el('div', { class: 'agent-chat-head' },
          el('div', {},
            el('h2', { class: 'agent-chat-title', text: 'Agent chat' }),
            chatSub,
          ),
          el('div', { class: 'agent-head-actions' },
            aiBadge,
            el('button', { class: 'agent-chip', type: 'button', on: { click: clearChat } }, 'Clear'),
          ),
        ),
        chatMessages,
        chatChips,
        chatForm,
        el('details', { class: 'agent-ai-settings' }, aiSummary, aiForm),
      ),
      el('section', { class: 'admin-card admin-tools-card' },
        el('h2', { class: 'admin-card-title', text: 'Add a film' }),
        el('p', { class: 'admin-card-sub', text: 'Search by name, pick the result, press Add. No restart.' }),
        form,
        status,
        results,
        el('h3', { class: 'admin-subtitle', text: 'Custom films' }),
        customList,
        el('p', { class: 'admin-foot', text: 'Entries are stored in data/custom-films.json. Removing one here removes it from the catalogue.' }),
      ),
    ),
    el('section', { class: 'admin-card admin-traffic' },
      el('div', { class: 'admin-doctor-head' },
        el('div', {},
          el('h2', { class: 'admin-section-title', text: 'Traffic' }),
          el('p', { class: 'admin-doctor-sub', text: 'Who came today, where from, and what they watched.' }),
        ),
        el('div', { class: 'traffic-ranges' }, ...rangeButtons),
      ),
      trafficKpis,
      trafficChart,
      el('div', { class: 'traffic-columns' },
        el('div', {}, el('h3', { class: 'admin-subtitle', text: 'Countries' }), trafficCountries),
        el('div', {}, el('h3', { class: 'admin-subtitle', text: 'Most played' }), trafficTitles),
        el('div', {}, el('h3', { class: 'admin-subtitle', text: 'Sources · devices' }), trafficSources),
      ),
      trafficNote,
    ),
    el('section', { class: 'admin-card admin-doctor' },
      el('div', { class: 'admin-doctor-head' },
        el('div', {},
          el('h2', { class: 'admin-section-title', text: 'Site doctor' }),
          el('p', { class: 'admin-doctor-sub', text: 'Checks the running server, catalogue, data files, images, captions and network. Fixes only safe, known failures.' }),
        ),
        el('div', { class: 'admin-doctor-actions' }, runButton, fixAllButton, copyButton),
      ),
      doctorSummary,
      doctorList,
    ),
  );

  chatInput.focus();
  void loadCustom();
  void loadTraffic();
  // The panel is usually left open on a second screen: refresh the counters so
  // the numbers are current without a reload.
  const trafficTimer = setInterval(() => {
    if (signal?.aborted) return;
    void loadTraffic();
  }, 45_000);
  signal?.addEventListener('abort', () => clearInterval(trafficTimer), { once: true });
  void runDoctor();
}

/* ------------------------------- code agent ------------------------------ */

async function renderCodeAgent(signal) {
  hero.hidden = true;
  ui.clear(view);

  let session = { authenticated: false, ai: false, model: null };
  try {
    session = await adminSession();
  } catch {
    // show login below
  }
  if (signal?.aborted) return;
  if (!session.authenticated) {
    renderAdminLogin(signal, () => renderCodeAgent(signal));
    return;
  }

  document.title = 'Code agent — Injoy';

  const back = el('a', { class: 'btn btn-ghost btn-mini', href: '#/admin', text: 'Admin' });
  const lock = el('button', {
    class: 'btn btn-ghost btn-mini',
    type: 'button',
    on: {
      click: async () => {
        try { await adminLogout(); } catch { /* clear attempt */ }
        renderAdmin();
      },
    },
  }, 'Lock');

  const aiBadge = el('span', {
    class: session.ai ? 'agent-badge is-ai' : 'agent-badge',
    text: session.ai ? `AI · ${session.model ?? 'model'}` : 'Tools only',
  });

  const messages = el('div', { class: 'agent-messages', role: 'log', 'aria-live': 'polite' });
  const input = el('input', {
    class: 'agent-input', type: 'text', placeholder: 'Ask the code agent…',
    autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Message the code agent',
  });
  const send = el('button', { class: 'btn btn-primary btn-mini', type: 'submit' }, 'Send');
  const form = el('form', { class: 'agent-form' }, input, send);
  const chips = el('div', { class: 'agent-suggestions' });
  const editsWrap = el('div', { class: 'code-edits' });
  const savedCode = readStored(CODE_CHAT_KEY, null);
  let codeLog = Array.isArray(savedCode?.messages) ? savedCode.messages.slice(-60) : [];
  let savedEdits = Array.isArray(savedCode?.edits) ? savedCode.edits.slice(-20) : [];
  const seenEdits = new Set(savedEdits.map((entry) => entry.id));
  const CODE_WELCOME = 'I can list, read and search the repo, check syntax and run the site doctor. Edits are proposed as a diff and never written until you press Apply.';
  let history = codeLog
    .filter((entry) => entry.role === 'user' || entry.role === 'agent')
    .slice(-12)
    .map((entry) => ({ role: entry.role === 'agent' ? 'assistant' : 'user', content: entry.text }));
  const persistCode = () => writeStored(CODE_CHAT_KEY, {
    messages: codeLog.slice(-60),
    edits: savedEdits.slice(-20),
    updatedAt: Date.now(),
  });

  const append = (role, text, { record = true } = {}) => {
    const row = el('div', { class: `agent-msg ${role}` },
      el('div', { class: 'agent-bubble' }, el('span', { text: String(text ?? '') })));
    messages.append(row);
    messages.scrollTop = messages.scrollHeight;
    if (record) {
      codeLog.push({ role, text: String(text ?? '').slice(0, 8_000) });
      codeLog = codeLog.slice(-60);
      persistCode();
    }
    return row;
  };

  const clearCode = () => {
    dropStored(CODE_CHAT_KEY);
    codeLog = [];
    savedEdits = [];
    seenEdits.clear();
    history = [];
    messages.replaceChildren();
    editsWrap.replaceChildren();
    append('agent', CODE_WELCOME, { record: false });
    ui.toast('Code chat cleared');
  };

  const renderEdit = (edit, { record = true } = {}) => {
    if (!edit?.id || seenEdits.has(edit.id)) return;
    seenEdits.add(edit.id);
    if (record) {
      savedEdits.push(edit);
      savedEdits = savedEdits.slice(-20);
      persistCode();
    }

    const diff = el('pre', { class: 'code-diff' });
    for (const line of String(edit.diff ?? '').split('\n')) {
      diff.append(el('span', {
        class: line.startsWith('+') ? 'diff-add' : line.startsWith('-') ? 'diff-del' : 'diff-ctx',
        text: `${line}\n`,
      }));
    }

    const note = el('p', { class: 'code-edit-note' });
    const apply = el('button', { class: 'btn btn-primary btn-mini', type: 'button' }, 'Apply');
    const reject = el('button', { class: 'btn btn-ghost btn-mini', type: 'button' }, 'Reject');

    apply.addEventListener('click', async () => {
      apply.disabled = true;
      reject.disabled = true;
      apply.textContent = 'Applying…';
      try {
        const result = await codeApply(edit.id);
        apply.textContent = 'Applied';
        reject.remove();
        savedEdits = savedEdits.filter((entry) => entry.id !== edit.id);
        persistCode();
        note.textContent = `Applied · ${result.check?.detail ?? 'ok'}${result.restartRequired
          ? ' · restart the Node server to load it'
          : ' · hard-refresh the browser to load it'}`;
        ui.toast('Edit applied');
      } catch (err) {
        apply.disabled = false;
        reject.disabled = false;
        apply.textContent = 'Apply';
        note.textContent = `Could not apply: ${err.message}`;
      }
    });

    reject.addEventListener('click', async () => {
      try { await codeReject(edit.id); } catch { /* pending edits expire anyway */ }
      savedEdits = savedEdits.filter((entry) => entry.id !== edit.id);
      persistCode();
      card.remove();
      ui.toast('Edit rejected');
    });

    const card = el('article', { class: 'code-edit' },
      el('div', { class: 'code-edit-head' },
        el('div', {},
          el('strong', { class: 'code-edit-path', text: edit.path }),
          edit.summary ? el('p', { class: 'code-edit-summary', text: edit.summary }) : null,
        ),
        el('span', { class: 'chip subtle', text: 'pending' }),
      ),
      diff,
      el('div', { class: 'code-edit-actions' }, apply, reject, note),
    );
    editsWrap.append(card);
    editsWrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };

  const sendMessage = async (text) => {
    const message = String(text ?? input.value).trim();
    if (!message) return;
    append('user', message);
    input.value = '';
    send.disabled = true;
    const thinking = append('agent', 'Working…', { record: false });
    try {
      const data = await codeChat(message, history);
      thinking.remove();
      const reply = data.reply ?? 'Done.';
      append('agent', reply);
      history = codeLog
        .filter((entry) => entry.role === 'user' || entry.role === 'agent')
        .slice(-12)
        .map((entry) => ({ role: entry.role === 'agent' ? 'assistant' : 'user', content: entry.text }));
      for (const edit of data.edits ?? []) renderEdit(edit);
    } catch (err) {
      thinking.remove();
      if (err.status === 401) { renderAdmin(); return; }
      append('agent', `Error: ${err.message}`, { record: false });
    } finally {
      send.disabled = false;
      input.focus();
    }
  };

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void sendMessage();
  });

  for (const label of ['Run the site doctor', 'List the files in server/lib', 'Read server/index.js', 'Search for adminAllowed', 'Check public/js/app.js']) {
    chips.append(el('button', {
      class: 'agent-chip', type: 'button',
      on: { click: () => { void sendMessage(label); } },
    }, label));
  }

  if (codeLog.length) {
    for (const entry of codeLog) {
      if (entry?.role === 'user' || entry?.role === 'agent') {
        append(entry.role, entry.text, { record: false });
      }
    }
  } else {
    append('agent', CODE_WELCOME, { record: false });
  }
  for (const edit of savedEdits) renderEdit(edit, { record: false });

  const nodes = [
    pageHead('Code agent', 'Reads the repo, proposes edits and checks syntax. You approve every write.', [back, lock]),
  ];
  if (!session.ai) {
    nodes.push(el('div', { class: 'admin-card code-note' },
      el('p', { text: 'Running without a model. Listing, reading, searching, syntax checks and the site doctor work now; free-form explanations and code proposals need a model.' }),
      el('a', { class: 'btn btn-ghost btn-mini', href: '#/admin', text: 'Add a model' }),
    ));
  }
  nodes.push(
    el('section', { class: 'admin-card agent-chat-card' },
      el('div', { class: 'agent-chat-head' },
        el('div', {},
          el('h2', { class: 'agent-chat-title', text: 'Code chat' }),
          el('p', { class: 'agent-chat-sub', text: 'Changes are proposed, never written until you press Apply.' }),
        ),
        el('div', { class: 'agent-head-actions' },
          aiBadge,
          el('button', { class: 'agent-chip', type: 'button', on: { click: clearCode } }, 'Clear'),
        ),
      ),
      messages,
      chips,
      form,
    ),
    editsWrap,
    el('p', { class: 'admin-foot', text: 'Applied edits are backed up under data/backups/code. Server-side changes need a Node restart; static changes need a hard refresh.' }),
  );
  view.append(...nodes);
  input.focus();
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
