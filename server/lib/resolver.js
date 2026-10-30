import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Stream resolver.
 *
 * The embed pages do not hand out a playable URL. They boot a player, trade a
 * short-lived token, and only then request the manifest — so the URL cannot be
 * constructed, only observed. Chrome is on most Windows boxes, and Chrome can
 * be told to write a netlog, so that is the resolver: launch headless Chrome on
 * the embed page, let its own JS do the work, then read the requests it made.
 *
 * Netlog is used instead of CDP because it needs no socket protocol and no
 * extra dependency: the file is a stream of request URLs, and the manifest URL
 * is in it verbatim.
 */

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  // Ubuntu on ARM installs Chromium as a snap; Google does not ship a Linux
  // ARM build of Chrome. The A1 shape is ARM, so this path matters.
  '/snap/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

// Ad and analytics hosts that also serve .mp4 banners; never the feature.
const NOISE = /(doubleclick|googlesyndication|google-analytics|googletagmanager|llvpn|tagivi|sharethis|cloudflareinsights|facebook\.net|scorecardresearch|criteo|taboola|outbrain|adnxs|rubiconproject|pubmatic|openx)/i;
const MANIFEST = /https?:\/\/[^"'\s\\]+?\.(?:m3u8|mpd)(?:\?[^"'\s\\]*)?/gi;
const PROGRESSIVE = /https?:\/\/[^"'\s\\]+?\.mp4(?:\?[^"'\s\\]*)?/gi;

export function chromePath() {
  return CHROME_CANDIDATES.find((candidate) => existsSync(candidate)) ?? null;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function killTree(child) {
  if (!child || child.killed) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      child.kill('SIGKILL');
    }
  } catch {
    // the process is already gone
  }
}

function pickCandidate(text) {
  const manifests = [...text.matchAll(MANIFEST)].map((m) => m[0]).filter((u) => !NOISE.test(u));
  if (manifests.length) {
    // The master playlist is the shortest path — prefer .m3u8 over .mpd.
    const hls = manifests.filter((u) => u.includes('.m3u8'));
    if (hls.length) return { url: hls[0], type: 'hls' };
    return { url: manifests[0], type: 'dash' };
  }
  const progressive = [...text.matchAll(PROGRESSIVE)].map((m) => m[0]).filter((u) => !NOISE.test(u));
  if (progressive.length) return { url: progressive[0], type: 'progressive' };
  return null;
}

/**
 * Load `pageUrl` in headless Chrome and return the first media request it
 * makes. Resolves to `{ url, type, referer }` or null when nothing surfaces
 * inside the timeout.
 */
export async function sniffStream(pageUrl, { timeoutMs = 30_000, pollMs = 600, signal = null, windowSize = '1920,1080' } = {}) {
  const chrome = chromePath();
  if (!chrome) return { error: 'no chrome or edge binary found' };
  if (signal?.aborted) return { error: 'cancelled' };

  const dir = await mkdtemp(join(tmpdir(), 'injoy-sniff-'));
  const netlog = join(dir, 'netlog.json');
  const profile = join(dir, 'profile');

  const child = spawn(chrome, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--autoplay-policy=no-user-gesture-required',
    '--mute-audio',
    // A service account on a locked-down Linux host cannot start Chrome's
    // sandbox; the deploy unit sets this and the browser still sniffs fine.
    ...(process.env.CHROME_NO_SANDBOX === '1' ? ['--no-sandbox', '--disable-dev-shm-usage'] : []),
    `--window-size=${windowSize}`,
    `--user-data-dir=${profile}`,
    '--log-net-log=' + netlog,
    '--net-log-capture-mode=IncludeSensitive',
    pageUrl,
  ], { stdio: 'ignore', windowsHide: true });

  const deadline = Date.now() + timeoutMs;
  let found = null;
  let lastSize = 0;

  try {
    while (Date.now() < deadline) {
      await sleep(pollMs);
      if (signal?.aborted) return { error: 'cancelled' };
      const info = await stat(netlog).catch(() => null);
      if (!info || info.size === lastSize) continue;
      lastSize = info.size;
      const text = await readFile(netlog, 'utf8').catch(() => '');
      found = pickCandidate(text);
      if (found) break;
    }
  } finally {
    killTree(child);
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }

  if (!found) return { error: 'no media request observed' };
  return { ...found, referer: new URL(pageUrl).origin };
}

function filmEmbeds(tmdbId, imdbId) {
  const list = [];
  // vidlink answers in a few seconds and hands back a real manifest; vidsrc.pm
  // carries the long tail vidlink is missing (Interstellar among them). The rest
  // are slower and mostly return nothing, so they only ever run as fallbacks.
  if (tmdbId) list.push(`https://vidlink.pro/movie/${tmdbId}`);
  if (tmdbId) list.push(`https://vidsrc.pm/embed/movie/${tmdbId}`);
  list.push(`https://vidsrc.to/embed/movie/${tmdbId}`);
  list.push(`https://www.2embed.cc/embed/${tmdbId}`);
  list.push(`https://vidsrc.me/embed/movie?tmdb=${tmdbId}`);
  if (imdbId) list.push(`https://www.2embed.cc/embed/${imdbId}`);
  return list;
}

function episodeEmbeds(tmdbId, imdbId, season, episode) {
  const list = [];
  if (tmdbId) list.push(`https://vidlink.pro/tv/${tmdbId}/${season}/${episode}`);
  if (tmdbId) list.push(`https://vidsrc.pm/embed/tv/${tmdbId}/${season}/${episode}`);
  if (imdbId) {
    list.push(`https://vidsrc.to/embed/tv?imdb=${imdbId}&season=${season}&episode=${episode}`);
    list.push(`https://www.2embed.cc/embedtv/${imdbId}&s=${season}&e=${episode}`);
  }
  if (tmdbId) {
    list.push(`https://vidsrc.to/embed/tv/${tmdbId}/${season}/${episode}`);
    list.push(`https://www.2embed.cc/embedtv/${tmdbId}&s=${season}&e=${episode}`);
  }
  return list;
}

// How long a provider runs alone before the next one is launched alongside it.
// Serial hunting made a miss cost a full 30 s timeout each, so an unavailable
// title took two minutes to give up; hedging overlaps the waits instead.
const HEDGE_MS = 5_000;

/**
 * Try the embed pages until one produces a media request.
 *
 * Providers are hedged rather than raced flat: the first page gets a head start,
 * the next joins after `HEDGE_MS`, and the first hit wins and cancels the rest.
 * That keeps the fast provider's quality when it answers, without paying its
 * full timeout when it does not. Each attempt is a fresh headless browser, so a
 * dead provider costs one timeout, not the whole resolution.
 */
export async function resolveStream({ tmdbId, imdbId = null, season = null, episode = null, onAttempt = null }) {
  const pages = season && episode
    ? episodeEmbeds(tmdbId, imdbId, season, episode)
    : filmEmbeds(tmdbId, imdbId);

  const tried = [];
  if (!pages.length) return { error: 'no provider for this title', tried };

  const controller = new AbortController();

  return new Promise((resolve) => {
    let settled = false;
    let launched = 0;
    const timers = [];

    const finish = (result) => {
      if (settled) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      controller.abort();
      resolve(result);
    };

    const launch = () => {
      if (settled || launched >= pages.length) return;
      const page = pages[launched];
      launched += 1;
      onAttempt?.(page);

      sniffStream(page, { signal: controller.signal }).then((result) => {
        tried.push({ page, ...result });
        if (result.url) {
          finish({ ...result, page, tried });
          return;
        }
        if (tried.length >= pages.length) {
          finish({ error: 'no provider produced a stream', tried });
          return;
        }
        launch();
      });

      if (launched < pages.length) timers.push(setTimeout(launch, HEDGE_MS));
    };

    launch();
  });
}
