/**
 * Visit analytics.
 *
 * Every page load, every route change the browser reports, and every play is
 * folded into one record per day. Addresses are salted and hashed — the file
 * can count unique visitors without ever holding an IP.
 *
 * Country comes from a free lookup that is fired and forgotten: a failed lookup
 * costs nothing, it just leaves the country empty for that visitor. The result is
 * cached per address so a returning viewer never asks twice.
 */

import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const DATA_DIR = process.env.DATA_DIR ?? join(process.cwd(), 'data');
const FILE = join(DATA_DIR, 'analytics.json');
const KEEP_DAYS = 180;
const FLUSH_MS = 4_000;
const GEO_TIMEOUT_MS = 2_500;
const GEO_TTL_MS = 24 * 60 * 60_000;
const GEO_CACHE_MAX = 2_000;

let state = { salt: null, days: {} };
let loaded = false;
let dirty = false;
let flushTimer = null;

const geoCache = new Map();

const dayKey = (date = new Date()) => date.toISOString().slice(0, 10);

function blankDay() {
  return {
    views: 0,
    plays: 0,
    visitors: {},
    countries: {},
    cities: {},
    referrers: {},
    devices: {},
    pages: {},
    titles: {},
    hours: new Array(24).fill(0),
  };
}

function bump(map, key, by = 1) {
  if (!key) return;
  map[key] = (map[key] ?? 0) + by;
}

async function load() {
  if (loaded) return;
  loaded = true;
  try {
    const raw = await readFile(FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.days) state = parsed;
  } catch {
    // first run: a fresh file is written on the first visit
  }
  if (!state.salt) state.salt = randomBytes(16).toString('hex');
}

function scheduleFlush() {
  dirty = true;
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flush();
  }, FLUSH_MS);
  flushTimer.unref?.();
}

/** Write now. Called on a timer, on shutdown and by the admin route. */
export async function flush() {
  if (!dirty) return;
  dirty = false;
  try {
    await mkdir(dirname(FILE), { recursive: true });
    const tmp = `${FILE}.tmp`;
    await writeFile(tmp, JSON.stringify(state), 'utf8');
    await rename(tmp, FILE);
  } catch {
    dirty = true;
  }
}

function prune() {
  const keys = Object.keys(state.days).sort();
  const excess = keys.length - KEEP_DAYS;
  for (let at = 0; at < excess; at += 1) delete state.days[keys[at]];
}

export function clientIp(req) {
  const header = [
    req.headers['cf-connecting-ip'],
    req.headers['true-client-ip'],
    req.headers['x-real-ip'],
    String(req.headers['x-forwarded-for'] ?? '').split(',')[0],
    req.socket?.remoteAddress,
  ];
  for (const raw of header) {
    const ip = String(raw ?? '').trim();
    if (!ip) continue;
    // Render and Cloudflare both prepend the client and append their own hops;
    // the first public address in the chain is the visitor.
    if (!LOCAL.test(ip)) return ip.replace(/^::ffff:/, '');
  }
  const fallback = String(req.socket?.remoteAddress ?? '').replace(/^::ffff:/, '');
  return fallback;
}

const LOCAL = /^(::1|127\.|::ffff:127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|fc|fd|fe80)/i;

/** "🇺🇸 United States" — a flag makes a country list readable at a glance. */
function countryLabel(code, name) {
  if (!name || name === 'Unknown') return 'Unknown';
  if (!code || code.length !== 2 || !/^[A-Z]{2}$/.test(code)) return name;
  const flag = String.fromCodePoint(...[...code].map((letter) => 0x1f1e6 + letter.charCodeAt(0) - 65));
  return `${flag} ${name}`;
}

function deviceOf(ua) {
  if (!ua) return 'other';
  if (/iPad|Tablet|PlayBook|Silk/i.test(ua)) return 'tablet';
  if (/Mobi|iPhone|iPod|Android.*Mobile|Windows Phone/i.test(ua)) return 'mobile';
  if (/bot|crawler|spider|preview|curl|wget|headless/i.test(ua)) return 'bot';
  return 'desktop';
}

function referrerHost(value) {
  if (!value) return 'direct';
  try {
    const host = new URL(value).hostname.replace(/^www\./, '');
    if (!host) return 'direct';
    return host;
  } catch {
    return 'direct';
  }
}

// Every provider below is free and keyless. A hosted network can refuse one or
// two of them (ip-api answers only over plain HTTP, ipapi.co rate-limits a
// datacenter immediately), so the lookup walks the list instead of trusting a
// single host.
const GEO_PROVIDERS = [
  // ipinfo answers with a city as well as a country and is the quickest of the
  // five; the rest are there for when it starts refusing a datacenter address.
  async (ip, signal) => {
    const res = await fetch(`https://ipinfo.io/${encodeURIComponent(ip)}/json`, { signal, headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`ipinfo ${res.status}`);
    const body = await res.json();
    if (!body?.country) throw new Error('ipinfo empty');
    return { country: body.country, code: String(body.country).toUpperCase(), city: body.city ?? null };
  },
  async (ip, signal) => {
    const res = await fetch(`https://freeipapi.com/api/json/${encodeURIComponent(ip)}`, { signal });
    if (!res.ok) throw new Error(`freeipapi ${res.status}`);
    const body = await res.json();
    if (!body?.countryCode) throw new Error('freeipapi empty');
    return { country: body.countryName ?? body.countryCode, code: String(body.countryCode).toUpperCase(), city: body.cityName ?? null };
  },
  async (ip, signal) => {
    const res = await fetch(`https://api.country.is/${encodeURIComponent(ip)}`, { signal });
    if (!res.ok) throw new Error(`country.is ${res.status}`);
    const body = await res.json();
    if (!body?.country) throw new Error('country.is empty');
    return { country: body.country, code: String(body.country).toUpperCase(), city: null };
  },
  async (ip, signal) => {
    const res = await fetch(`https://ipwho.is/${encodeURIComponent(ip)}`, { signal });
    if (!res.ok) throw new Error(`ipwho ${res.status}`);
    const body = await res.json();
    if (!body?.success) throw new Error('ipwho refused');
    return { country: body.country ?? 'Unknown', code: String(body.country_code ?? '--').toUpperCase(), city: body.city ?? null };
  },
  async (ip, signal) => {
    const res = await fetch(`https://ipapi.co/${encodeURIComponent(ip)}/json/`, { signal, headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`ipapi ${res.status}`);
    const body = await res.json();
    if (body?.error) throw new Error('ipapi refused');
    return { country: body.country_name ?? 'Unknown', code: String(body.country_code ?? '--').toUpperCase(), city: body.city ?? null };
  },
];

function signalFor() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GEO_TIMEOUT_MS);
  timer.unref?.();
  controller.signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
  return controller.signal;
}

/** Country for an address, cached. Returns a promise that never rejects. */
export async function geoFor(ip) {
  if (!ip || LOCAL.test(ip)) return { country: 'Local', code: 'LO', city: null };
  const cached = geoCache.get(ip);
  if (cached && Date.now() - cached.at < GEO_TTL_MS) return cached.value;

  for (const provider of GEO_PROVIDERS) {
    try {
      const raw = await provider(ip, signalFor());
      const value = { ...raw, country: countryName(raw.code) ?? raw.country };
      if (geoCache.size > GEO_CACHE_MAX) geoCache.clear();
      geoCache.set(ip, { at: Date.now(), value });
      return value;
    } catch {
      // next provider
    }
  }

  const value = { country: 'Unknown', code: '--', city: null };
  // A failed lookup is remembered briefly: retrying every view would hammer the
  // providers for an address that is not going to resolve.
  geoCache.set(ip, { at: Date.now() - GEO_TTL_MS + 10 * 60_000, value });
  return value;
}

/** Country name from an ISO code, so every provider agrees on the spelling. */
function countryName(code) {
  if (!code || !/^[A-Z]{2}$/.test(code)) return null;
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(code) ?? null;
  } catch {
    return null;
  }
}

/** Ask every provider and report each verdict. Used by the admin diag route. */
export async function geoDebug(ip) {
  const out = [];
  for (let at = 0; at < GEO_PROVIDERS.length; at += 1) {
    const started = Date.now();
    try {
      const value = await GEO_PROVIDERS[at](ip, signalFor());
      out.push({ provider: at, ok: true, ms: Date.now() - started, ...value });
    } catch (err) {
      out.push({ provider: at, ok: false, ms: Date.now() - started, error: String(err.message ?? err).slice(0, 90) });
    }
  }
  return out;
}

/**
 * Record one event.
 *
 * `kind` is `view` for a document load, `route` for a client-side navigation and
 * `play` for a title being started. Recording is synchronous apart from the
 * country lookup, which finishes later and fills its slot in.
 */
export async function record(req, { kind = 'view', path = '/', title = null } = {}) {
  await load();

  const today = dayKey();
  const day = (state.days[today] ??= blankDay());

  const hour = new Date().getHours();
  day.hours[hour] += 1;

  if (kind === 'play') day.plays += 1;
  else day.views += 1;

  const ua = String(req.headers['user-agent'] ?? '');
  const ip = clientIp(req);

  if (kind !== 'route') {
    const visitor = createHash('sha1').update(`${state.salt}|${ip}|${ua}|${today}`).digest('hex').slice(0, 16);
    day.visitors[visitor] = 1;
    bump(day.devices, deviceOf(ua));
    bump(day.referrers, referrerHost(req.headers.referer));
  }

  bump(day.pages, path.slice(0, 120));
  if (title) bump(day.titles, String(title).slice(0, 120));

  prune();
  scheduleFlush();

  // Country is a property of the visitor, not of the event: counting it on a
  // play as well would push a single person past 100 % of the day's visitors.
  if (kind === 'view') {
    void geoFor(ip).then((geo) => {
      const slot = state.days[today] ??= blankDay();
      bump(slot.countries, countryLabel(geo.code, geo.country));
      if (geo.city && geo.country !== 'Unknown') bump(slot.cities, `${countryLabel(geo.code, geo.country)} · ${geo.city}`);
      scheduleFlush();
    });
  }
}

function sumDays(from, to) {
  const totals = {
    views: 0,
    plays: 0,
    visitors: 0,
    countries: {},
    cities: {},
    referrers: {},
    devices: {},
    pages: {},
    titles: {},
    hours: new Array(24).fill(0),
    series: {},
  };
  const keys = Object.keys(state.days).filter((key) => key >= from && key <= to).sort();
  const seen = new Set();

  for (const key of keys) {
    const day = state.days[key];
    totals.views += day.views ?? 0;
    totals.plays += day.plays ?? 0;
    for (const id of Object.keys(day.visitors ?? {})) seen.add(id);
    for (const field of ['countries', 'cities', 'referrers', 'devices', 'pages', 'titles']) {
      for (const [name, count] of Object.entries(day[field] ?? {})) bump(totals[field], name, count);
    }
    for (let hour = 0; hour < 24; hour += 1) totals.hours[hour] += day.hours?.[hour] ?? 0;
    totals.series[key] = {
      views: day.views ?? 0,
      plays: day.plays ?? 0,
      visitors: Object.keys(day.visitors ?? {}).length,
    };
  }

  totals.visitors = seen.size;
  return totals;
}

const top = (map, limit = 8) => Object.entries(map ?? {})
  .sort((a, b) => b[1] - a[1])
  .slice(0, limit)
  .map(([name, count]) => ({ name, count }));

/** Everything the admin dashboard needs, already shaped for display. */
export async function report(days = 1) {
  await load();
  const span = Math.min(180, Math.max(1, Number(days) || 1));
  const today = dayKey();
  const from = dayKey(new Date(Date.now() - (span - 1) * 86400000));

  const range = sumDays(from, today);
  const todayTotals = sumDays(today, today);

  const timeline = [];
  for (let back = Math.min(29, span + 13); back >= 0; back -= 1) {
    const key = dayKey(new Date(Date.now() - back * 86400000));
    const day = state.days[key];
    timeline.push({
      date: key,
      visitors: Object.keys(day?.visitors ?? {}).length,
      views: day?.views ?? 0,
      plays: day?.plays ?? 0,
    });
  }

  const share = (count) => {
    const total = Object.values(range.countries ?? {}).reduce((sum, value) => sum + value, 0);
    return total ? Math.round((count / total) * 1000) / 10 : 0;
  };

  return {
    generatedAt: new Date().toISOString(),
    span,
    today: {
      date: today,
      visitors: todayTotals.visitors,
      views: todayTotals.views,
      plays: todayTotals.plays,
      countries: top({ ...todayTotals.countries }, 6).map((entry) => ({
        ...entry,
        share: todayTotals.visitors ? Math.round((entry.count / todayTotals.visitors) * 1000) / 10 : 0,
      })),
      cities: top({ ...todayTotals.cities }, 4),
      devices: top({ ...todayTotals.devices }, 3),
    },
    range: {
      visitors: range.visitors,
      views: range.views,
      plays: range.plays,
      countries: top({ ...range.countries }, 12).map((entry) => ({ ...entry, share: share(entry.count) })),
      cities: top({ ...range.cities }, 8),
      devices: top({ ...range.devices }, 4),
      referrers: top({ ...range.referrers }, 8),
      pages: top({ ...range.pages }, 8),
      titles: top({ ...range.titles }, 10),
      hours: range.hours,
    },
    timeline,
  };
}

export function analyticsPath() {
  return FILE;
}
