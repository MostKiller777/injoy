import { getDetail } from './api.js';
import { inList, progressFor, toggleList } from './state.js';

/* ------------------------------- helpers -------------------------------- */

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'on') {
      for (const [event, handler] of Object.entries(value)) node.addEventListener(event, handler);
    } else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  append(node, children);
  return node;
}

export function append(node, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

const ICONS = {
  play: '<path d="M8 5.5v13l11-6.5z" fill="currentColor" stroke="none"/>',
  pause: '<path d="M9 5v14M15 5v14" stroke-width="2.6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  check: '<path d="m5 13 4 4L19 7"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  star: '<path d="m12 3 2.6 5.6 6.1.8-4.5 4.2 1.2 6-5.4-3-5.4 3 1.2-6L3.3 9.4l6.1-.8z"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  left: '<path d="m14 6-6 6 6 6"/>',
  right: '<path d="m10 6 6 6-6 6"/>',
  down: '<path d="m6 10 6 6 6-6"/>',
  up: '<path d="m6 14 6-6 6 6"/>',
  shuffle: '<path d="M3 7h3.5l3 5-3 5H3"/><path d="M21 7h-3.5l-6.2 10H8"/><path d="M17.5 17H21"/><path d="M17.5 7H21"/><path d="m17.8 5 2 2-2 2"/><path d="m17.8 15 2 2-2 2"/>',
  volume: '<path d="M11 5 7 9H4v6h3l4 4z"/><path d="M16 9a4 4 0 0 1 0 6"/><path d="M19 6a8 8 0 0 1 0 12"/>',
  mute: '<path d="M11 5 7 9H4v6h3l4 4z"/><path d="m16 9 5 6M21 9l-5 6"/>',
  pip: '<rect x="3" y="5" width="18" height="14" rx="2"/><rect x="12" y="11" width="7" height="6" rx="1" fill="currentColor" stroke="none"/>',
  fullscreen: '<path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3"/>',
  exitFullscreen: '<path d="M8 3v3a2 2 0 0 1-2 2H3M16 3v3a2 2 0 0 0 2 2h3M8 21v-3a2 2 0 0 0-2-2H3M16 21v-3a2 2 0 0 1 2-2h3"/>',
  back10: '<path d="M4 10a8 8 0 1 1 2.3 6.3"/><path d="M4 5v5h5"/>',
  fwd10: '<path d="M20 10a8 8 0 1 0-2.3 6.3"/><path d="M20 5v5h-5"/>',
  source: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m10 9 5 3-5 3z"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.6 9a2.5 2.5 0 1 1 3.7 2.2c-.7.4-1.3 1-1.3 1.8M12 17h.01"/>',
  external: '<path d="M14 4h6v6"/><path d="m20 4-9 9"/><path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/>',
  ticket: '<path d="M4 8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-2a2 2 0 0 0 0-4z"/>',
  cc: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M11 10.4a2.2 2.2 0 1 0 0 3.2"/><path d="M17 10.4a2.2 2.2 0 1 0 0 3.2"/>',
  download: '<path d="M12 4v11"/><path d="m7 12 5 5 5-5"/><path d="M5 20h14"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13"/><path d="M3.5 6h.01M3.5 12h.01M3.5 18h.01" stroke-width="2.4"/>',
};

export function icon(name, className = '') {
  const span = document.createElement('span');
  span.style.display = 'contents';
  span.innerHTML = `<svg class="${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] ?? ''}</svg>`;
  return span;
}

function visibleGenres(item, limit = 2) {
  return (item.genres ?? []).slice(0, limit);
}

export function formatRuntime(seconds) {
  if (!seconds || !Number.isFinite(seconds)) return null;
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.round((total % 3600) / 60);
  if (hours) return `${hours}h ${minutes.toString().padStart(2, '0')}m`;
  return `${minutes}m`;
}

export function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = (total % 60).toString().padStart(2, '0');
  if (hours) return `${hours}:${minutes.toString().padStart(2, '0')}:${secs}`;
  return `${minutes}:${secs}`;
}

export function compactNumber(value) {
  if (!Number.isFinite(value)) return null;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, '')}K`;
  return String(value);
}

export function initials(name) {
  return String(name ?? '?')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join('');
}

export function toast(message, kind = 'ok', ttl = 3200) {
  const root = document.getElementById('toast-root');
  if (!root) return;
  const node = el('div', { class: `toast ${kind === 'ok' ? '' : kind}`, role: 'status' },
    el('span', { class: 'dot' }),
    el('span', { text: message }),
  );
  root.append(node);
  setTimeout(() => {
    node.classList.add('is-out');
    setTimeout(() => node.remove(), 240);
  }, ttl);
}

/* --------------------------------- cards -------------------------------- */

function artFallback(item) {
  return el('div', { class: 'card-fallback' },
    el('span', { text: 'Injoy' }),
    el('strong', { text: item.title }),
  );
}

export function card(item, { layout = 'poster', index = 0, onOpen, onPlay } = {}) {
  const progress = progressFor(item.id);
  const art = el('div', { class: 'card-art skeleton' });

  if (item.poster) {
    const img = el('img', {
      alt: '',
      loading: 'lazy',
      decoding: 'async',
      referrerpolicy: 'no-referrer',
    });
    img.addEventListener('load', () => {
      img.classList.add('is-loaded');
      art.classList.remove('skeleton');
    }, { once: true });
    img.addEventListener('error', () => {
      art.classList.remove('skeleton');
      img.remove();
      art.prepend(artFallback(item));
    }, { once: true });
    img.src = item.poster;
    art.append(img);
  } else {
    art.classList.remove('skeleton');
    art.append(artFallback(item));
  }

  if (item.rating) {
    art.append(el('div', { class: 'card-rating', title: `${item.rating} / 10` },
      icon('star'), el('span', { text: item.rating.toFixed(1) }),
    ));
  }

  if (layout === 'number') {
    art.append(el('div', { class: 'card-rank', 'aria-hidden': 'true', text: String(index + 1).padStart(2, '0') }));
  }

  if (item.year && item.year >= new Date().getFullYear()) {
    art.append(el('div', { class: 'card-badge', text: 'New' }));
  }

  const progressEl = progress && progress.d && progress.t > 10
    ? el('div', { class: 'card-progress' },
        el('i', { style: { width: `${Math.min(100, (progress.t / progress.d) * 100).toFixed(1)}%` } }))
    : null;

  const listButton = el('button', {
    type: 'button',
    'aria-label': inList(item.id) ? 'Remove from my list' : 'Add to my list',
    title: inList(item.id) ? 'Remove from my list' : 'Add to my list',
    on: {
      click: async (event) => {
        event.stopPropagation();
        const { added } = await toggleList(item);
        listButton.replaceChildren(icon(added ? 'check' : 'plus'));
        listButton.setAttribute('aria-label', added ? 'Remove from my list' : 'Add to my list');
        toast(added ? `Added “${item.title}” to your list` : `Removed “${item.title}”`);
      },
    },
  }, icon(inList(item.id) ? 'check' : 'plus'));

  const playButton = el('button', {
    type: 'button',
    'aria-label': `Play ${item.title}`,
    title: 'Play',
    on: {
      click: (event) => {
        event.stopPropagation();
        onPlay?.(item);
      },
    },
  }, icon('play'));

  append(art, [
    el('div', { class: 'card-shade', 'aria-hidden': 'true' }),
    el('div', { class: 'card-info' },
      el('h3', { text: item.title }),
      el('p', {},
        item.year ? el('span', { text: String(item.year) }) : null,
        item.rating ? el('span', { text: `★ ${item.rating.toFixed(1)}` }) : null,
      ),
      el('div', { class: 'card-actions' }, playButton, listButton),
    ),
    progressEl,
  ]);

  const node = el('article', {
    class: 'card',
    'data-id': item.id,
    tabindex: '0',
    role: 'button',
    'aria-label': `${item.title}${item.year ? ` (${item.year})` : ''} — more info`,
    on: {
      click: () => onOpen?.(item),
      keydown: (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onOpen?.(item);
        }
      },
    },
  }, art, el('div', { class: 'card-title-mobile', text: item.title }));

  return node;
}

/* --------------------------------- rails -------------------------------- */

function attachDrag(track) {
  let originX = 0;
  let originScroll = 0;
  let dragging = false;
  let moved = false;

  track.addEventListener('pointerdown', (event) => {
    if (event.pointerType !== 'mouse' || event.button !== 0) return;
    dragging = true;
    moved = false;
    originX = event.clientX;
    originScroll = track.scrollLeft;
  });

  track.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    const delta = event.clientX - originX;
    if (Math.abs(delta) > 5) {
      moved = true;
      track.classList.add('is-dragging');
      track.scrollLeft = originScroll - delta;
    }
  });

  const end = () => {
    if (!dragging) return;
    dragging = false;
    track.classList.remove('is-dragging');
    if (moved) {
      track.addEventListener('click', (event) => {
        event.stopPropagation();
        event.preventDefault();
      }, { capture: true, once: true });
    }
  };

  track.addEventListener('pointerup', end);
  track.addEventListener('pointerleave', end);
  track.addEventListener('pointercancel', end);
}

export function rail(row, handlers = {}) {
  const track = el('div', { class: 'rail-track', role: 'list' });
  row.items.forEach((item, index) => {
    track.append(card(item, { layout: row.layout ?? 'poster', index, ...handlers }));
  });

  const prev = el('button', {
    class: 'rail-arrow', type: 'button', 'aria-label': 'Scroll left', disabled: true,
    on: { click: () => track.scrollBy({ left: -track.clientWidth * 0.82, behavior: 'smooth' }) },
  }, icon('left'));
  const next = el('button', {
    class: 'rail-arrow', type: 'button', 'aria-label': 'Scroll right',
    on: { click: () => track.scrollBy({ left: track.clientWidth * 0.82, behavior: 'smooth' }) },
  }, icon('right'));

  const sync = () => {
    prev.disabled = track.scrollLeft <= 4;
    next.disabled = track.scrollLeft + track.clientWidth >= track.scrollWidth - 4;
  };
  track.addEventListener('scroll', sync, { passive: true });
  window.addEventListener('resize', sync, { passive: true });
  requestAnimationFrame(sync);

  attachDrag(track);

  return el('section', { class: `rail${row.layout === 'number' ? ' rail--number' : ''}${row.layout === 'wide' ? ' rail--wide' : ''}` },
    el('div', { class: 'rail-head' },
      el('h2', { class: 'rail-title', text: row.title }),
      row.sub ? el('span', { class: 'rail-sub', text: row.sub }) : null,
      el('div', { class: 'rail-nav' }, prev, next),
    ),
    track,
  );
}

/* --------------------------------- hero --------------------------------- */

export function renderHero(item, { onPlay, onOpen } = {}) {
  const hero = document.getElementById('hero');
  if (!hero || !item) return;
  clear(hero);
  hero.hidden = false;

  const art = el('div', { class: `hero-art${item.backdrop ? '' : ' is-fallback'}` });
  if (item.backdrop) {
    art.append(el('img', { src: item.backdrop, alt: '', fetchpriority: 'high', referrerpolicy: 'no-referrer' }));
  }

  const meta = el('div', { class: 'hero-meta' });
  meta.append(el('span', { class: 'chip acc', text: 'Featured' }));
  if (item.year) meta.append(el('span', { text: String(item.year) }));
  if (item.rating) meta.append(el('span', { class: 'chip hot' }, icon('star'), el('span', { text: item.rating.toFixed(1) })));
  if (item.runtime) meta.append(el('span', { text: formatRuntime(item.runtime) }));
  for (const genre of visibleGenres(item, 2)) meta.append(el('span', { class: 'chip', text: genre }));

  hero.append(
    art,
    el('div', { class: 'hero-body' },
      el('div', { class: 'hero-kicker', text: 'Tonight on injoy' }),
      el('h1', { class: 'hero-title', text: item.title }),
      meta,
      item.overview ? el('p', { class: 'hero-overview', text: item.overview }) : null,
      el('div', { class: 'hero-actions' },
        el('button', { class: 'btn btn-primary', type: 'button', on: { click: () => onPlay?.(item) } },
          icon('play'), el('span', { text: 'Play' })),
        el('button', { class: 'btn btn-ghost', type: 'button', on: { click: () => onOpen?.(item) } },
          icon('info'), el('span', { text: 'More info' })),
      ),
    ),
  );
}

export function heroSkeleton() {
  const hero = document.getElementById('hero');
  if (!hero) return;
  hero.hidden = false;
  clear(hero).append(el('div', { class: 'hero-art skeleton', style: { opacity: 0.35 } }));
}

/* ------------------------------- home view ------------------------------ */

export function homeSkeleton() {
  const view = document.getElementById('view');
  heroSkeleton();
  clear(view);
  for (let i = 0; i < 2; i += 1) {
    view.append(el('div', { class: 'rail' },
      el('div', { class: 'rail-head' }, el('div', { class: 'skeleton', style: { width: '220px', height: '20px', borderRadius: '6px' } })),
      el('div', { class: 'skeleton-rail' },
        Array.from({ length: 7 }, () => el('div', { class: 'skeleton-card skeleton' })),
      ),
    ));
  }
}

export function emptyState({ title, message, actionLabel, onAction }) {
  return el('div', { class: 'state' },
    el('strong', { text: title }),
    message ? el('p', { text: message }) : null,
    actionLabel ? el('button', { class: 'btn btn-ghost btn-mini', type: 'button', on: { click: onAction } }, actionLabel) : null,
  );
}

export function gridCard(item, handlers) {
  return card(item, { layout: 'poster', ...handlers });
}

export function buildGrid(items, handlers = {}) {
  const grid = el('div', { class: 'grid' });
  for (const item of items) grid.append(card(item, handlers));
  return grid;
}

/* ------------------------------ detail modal ---------------------------- */

let activeModal = null;

export function closeDetail() {
  if (!activeModal) return;
  activeModal.close();
  activeModal = null;
}

export function isDetailOpen() {
  return Boolean(activeModal);
}

export async function openDetail(itemOrId, handlers = {}) {
  const id = typeof itemOrId === 'string' ? itemOrId : itemOrId?.id;
  if (!id) return;

  closeDetail();

  const previouslyFocused = document.activeElement;
  const overlay = el('div', { class: 'overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Film details' });
  const panel = el('div', { class: 'detail' },
    el('div', { class: 'detail-hero' },
      el('div', { class: 'detail-hero-body' },
        el('div', { class: 'skeleton', style: { width: '60%', height: '34px', borderRadius: '8px' } }),
        el('div', { class: 'skeleton', style: { width: '40%', height: '16px', borderRadius: '6px' } }),
      ),
    ),
    el('div', { class: 'detail-body' },
      el('div', { class: 'detail-main' },
        el('div', { class: 'skeleton', style: { height: '80px', borderRadius: '10px' } }),
      ),
      el('div', { class: 'detail-side' },
        el('div', { class: 'skeleton', style: { height: '140px', borderRadius: '10px' } }),
      ),
    ),
  );
  overlay.append(panel);

  const closeButton = el('button', {
    class: 'detail-close', type: 'button', 'aria-label': 'Close details',
    on: { click: () => close() },
  }, icon('close'));
  panel.append(closeButton);

  const onKeydown = (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      close();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusables = panel.querySelectorAll('button, [href], input, select, [tabindex]:not([tabindex="-1"])');
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const close = () => {
    document.removeEventListener('keydown', onKeydown, true);
    overlay.remove();
    if (!document.getElementById('player-root')?.childElementCount) document.body.classList.remove('is-locked');
    previouslyFocused?.focus?.({ preventScroll: true });
    activeModal = null;
    handlers.onClose?.();
  };

  document.addEventListener('keydown', onKeydown, true);
  document.body.classList.add('is-locked');
  document.getElementById('modal-root').append(overlay);
  activeModal = { close };
  closeButton.focus({ preventScroll: true });

  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) close();
  });

  let detail;
  try {
    detail = await getDetail(id);
  } catch (err) {
    clear(panel).append(
      closeButton,
      el('div', { class: 'state', style: { padding: '80px 24px' } },
        el('strong', { text: 'Could not load this film' }),
        el('p', { text: err.message }),
        el('button', { class: 'btn btn-ghost btn-mini', type: 'button', on: { click: () => { close(); openDetail(id, handlers); } } }, 'Try again'),
      ),
    );
    return;
  }

  renderDetail(panel, detail, {
    ...handlers,
    close,
    replace: (nextId) => {
      close();
      openDetail(nextId, handlers);
    },
  });

  // Series hand themselves straight to the player; the panel stays behind so
  // closing playback drops back onto the show, not the grid.
  handlers.onLoaded?.(detail);
}

function metaRow(detail) {
  const row = el('div', { class: 'detail-meta' });
  if (detail.year) row.append(el('span', { text: String(detail.year) }));
  if (detail.runtime) row.append(el('span', { text: formatRuntime(detail.runtime) }));
  if (detail.rating) row.append(el('span', { class: 'chip hot' }, icon('star'), el('span', { text: `${detail.rating.toFixed(1)} / 10` })));
  if (detail.votes) row.append(el('span', { text: `${compactNumber(detail.votes)} votes` }));
  for (const genre of visibleGenres(detail, 3)) row.append(el('span', { class: 'chip', text: genre }));
  return row;
}

/**
 * Season selector + episode rows. Episodes carry `playId` (`tv:<id>:<s>:<e>`);
 * playback resolves sources off that, while recents and the watchlist stay
 * keyed on the base `tv:<id>` so a show is one library entry, not 151.
 */
function seriesBrowser(detail, handlers) {
  const seasons = detail.seasons ?? [];
  const wrap = el('section', { class: 'episodes' });
  if (!seasons.length) return wrap;

  const tabs = el('div', { class: 'season-tabs', role: 'tablist', 'aria-label': 'Seasons' });
  const list = el('div', { class: 'episode-list' });
  wrap.append(
    el('h3', { class: 'section-label', text: 'Episodes' }),
    tabs,
    list,
  );

  const paint = (seasonNumber) => {
    const season = seasons.find((entry) => entry.number === seasonNumber) ?? seasons[0];
    tabs.querySelectorAll('.season-tab').forEach((tab) => {
      const active = Number(tab.dataset.season) === season.number;
      tab.classList.toggle('is-active', active);
      tab.setAttribute('aria-selected', active ? 'true' : 'false');
    });

    list.replaceChildren(...season.episodes.map((episode) => {
      const meta = [
        episode.airdate ?? null,
        episode.runtime ? `${Math.round(episode.runtime / 60)} min` : null,
      ].filter(Boolean).join(' · ');

      return el('button', {
        class: 'episode', type: 'button',
        on: {
          click: () => {
            handlers.close();
            handlers.onPlay?.({
              ...detail,
              playId: episode.playId,
              title: `${detail.title} — S${season.number}E${episode.number} · ${episode.name}`,
            });
          },
        },
      },
        el('span', { class: 'episode-num', text: String(episode.number).padStart(2, '0') }),
        el('span', { class: 'episode-body' },
          el('span', { class: 'episode-name', text: episode.name }),
          meta ? el('span', { class: 'episode-meta', text: meta }) : null,
          episode.summary ? el('span', { class: 'episode-summary', text: episode.summary }) : null,
        ),
        el('span', { class: 'episode-play', 'aria-hidden': 'true', text: '▶' }),
      );
    }));
  };

  for (const season of seasons) {
    tabs.append(el('button', {
      class: 'season-tab', type: 'button', role: 'tab',
      'aria-selected': 'false',
      'data-season': String(season.number),
      on: { click: () => paint(season.number) },
    }, `Season ${season.number}`));
  }

  paint(seasons[0].number);
  return wrap;
}

function renderDetail(panel, detail, handlers) {
  clear(panel);

  const art = detail.backdrop || detail.poster;
  const hero = el('div', { class: 'detail-hero' });
  if (art) hero.append(el('img', { src: art, alt: '', referrerpolicy: 'no-referrer' }));
  hero.append(
    el('div', { class: 'detail-hero-body' },
      detail.tagline ? el('div', { class: 'hero-kicker', text: detail.tagline }) : null,
      el('h2', { text: detail.title }),
      metaRow(detail),
    ),
  );

  const closeButton = el('button', {
    class: 'detail-close', type: 'button', 'aria-label': 'Close details',
    on: { click: () => handlers.close() },
  }, icon('close'));

  const playButton = el('button', {
    class: 'btn btn-primary', type: 'button',
    on: {
      click: () => {
        handlers.close();
        handlers.onPlay?.(detail);
      },
    },
  }, icon('play'), el('span', { text: 'Play now' }));

  const listButton = el('button', {
    class: 'btn btn-ghost', type: 'button',
    on: {
      click: async () => {
        const { added } = await toggleList(detail);
        listButton.replaceChildren(icon(added ? 'check' : 'plus'), el('span', { text: added ? 'In my list' : 'My list' }));
        toast(added ? 'Added to your list' : 'Removed from your list');
      },
    },
  }, icon(inList(detail.id) ? 'check' : 'plus'), el('span', { text: inList(detail.id) ? 'In my list' : 'My list' }));

  const actions = el('div', { class: 'detail-actions' }, playButton, listButton);
  if (detail.trailer) {
    actions.append(el('a', {
      class: 'btn btn-ghost', href: detail.trailer.url, target: '_blank', rel: 'noopener noreferrer',
    }, icon('ticket'), el('span', { text: 'Trailer' })));
  }

  const overview = el('p', { class: 'detail-overview', text: detail.overview || 'No synopsis on file for this one.' });

  const main = el('div', { class: 'detail-main' },
    overview,
    actions,
    detail.kind === 'series' ? seriesBrowser(detail, handlers) : null,
    (detail.cast ?? []).length ? el('div', {},
      el('h3', { class: 'section-label', text: 'Cast' }),
      el('div', { class: 'cast-row' },
        detail.cast.map((person) => el('div', { class: 'cast-card' },
          person.photo
            ? el('img', { src: person.photo, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' })
            : el('div', { class: 'cast-fallback', text: initials(person.name) }),
          el('strong', { text: person.name }),
          person.character ? el('span', { text: person.character }) : null,
        )),
      ),
    ) : null,
  );

  const facts = el('div', { class: 'facts' });
  const addFact = (label, value) => {
    if (!value) return;
    facts.append(el('div', {}, el('dt', { text: label }), el('dd', { text: value })));
  };
  addFact('Released', detail.releaseDate || detail.year);
  addFact('Runtime', detail.kind === 'series' && detail.runtime
    ? `${Math.round(detail.runtime / 60)} min / episode`
    : formatRuntime(detail.runtime));
  if (detail.kind === 'series') {
    addFact('Seasons', detail.seasons?.length ? String(detail.seasons.length) : null);
    addFact('Episodes', detail.seasons?.length
      ? String(detail.seasons.reduce((sum, season) => sum + season.episodes.length, 0))
      : null);
  }
  addFact('Director', detail.directors?.join(', ') || detail.creator);
  addFact('Genres', visibleGenres(detail, 4).join(' · '));
  addFact('Studio', detail.production?.join(', '));
  addFact('Rating', detail.rating ? `${detail.rating.toFixed(1)} / 10` : null);
  addFact('Votes', compactNumber(detail.votes));
  addFact('Source', detail.kind === 'series' ? 'TVMaze metadata' : 'TMDB metadata');

  const side = el('div', { class: 'detail-side' }, facts);

  panel.append(closeButton, hero, el('div', { class: 'detail-body' }, main, side));
  closeButton.focus({ preventScroll: true });

  if ((detail.similar ?? []).length) {
    const row = rail({ key: 'similar', title: 'More like this', items: detail.similar, layout: 'poster' }, {
      ...handlers,
      onOpen: (item) => handlers.replace?.(item.id),
    });
    row.classList.add('detail-similar');
    panel.append(row);
  }
}

/* ------------------------------- grid paging ----------------------------- */

export function observeSentinel(sentinel, onHit) {
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) onHit();
    }
  }, { rootMargin: '600px 0px' });
  observer.observe(sentinel);
  return () => observer.disconnect();
}
