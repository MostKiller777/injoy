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
export async function sniffStream(pageUrl, { timeoutMs = 30_000, pollMs = 600 } = {}) {
  const chrome = chromePath();
  if (!chrome) return { error: 'no chrome or edge binary found' };

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
    '--window-size=1280,720',
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
  const list = [
    `https://vidsrc.to/embed/movie/${tmdbId}`,
    `https://www.2embed.cc/embed/${tmdbId}`,
    `https://vidsrc.me/embed/movie?tmdb=${tmdbId}`,
    `https://vidlink.pro/movie/${tmdbId}`,
  ];
  if (imdbId) list.push(`https://www.2embed.cc/embed/${imdbId}`);
  return list;
}

function episodeEmbeds(tmdbId, imdbId, season, episode) {
  const list = [];
  if (imdbId) {
    list.push(`https://vidsrc.to/embed/tv?imdb=${imdbId}&season=${season}&episode=${episode}`);
    list.push(`https://www.2embed.cc/embedtv/${imdbId}&s=${season}&e=${episode}`);
  }
  list.push(`https://vidsrc.to/embed/tv/${tmdbId}/${season}/${episode}`);
  list.push(`https://www.2embed.cc/embedtv/${tmdbId}&s=${season}&e=${episode}`);
  return list;
}

/**
 * Try each embed page in turn until one produces a manifest. Each attempt is a
 * fresh headless browser, so a dead provider costs one timeout, not the job.
 *
 * HLS wins over DASH even when it turns up later: a DASH stream keeps video and
 * audio in separate tracks, and joining them needs a muxer this box does not
 * have. A DASH hit is kept only as a last resort so the caller can report
 * something specific.
 */
export async function resolveStream({ tmdbId, imdbId = null, season = null, episode = null, onAttempt = null }) {
  const pages = season && episode
    ? episodeEmbeds(tmdbId, imdbId, season, episode)
    : filmEmbeds(tmdbId, imdbId);

  const tried = [];
  let fallback = null;

  for (const page of pages) {
    onAttempt?.(page);
    const result = await sniffStream(page);
    tried.push({ page, ...result });
    if (!result.url) continue;
    if (result.type === 'hls' || /\.mp4(?:$|\?)/i.test(result.url)) return { ...result, page, tried };
    fallback ??= { ...result, page };
  }

  if (fallback) return { ...fallback, tried };
  return { error: 'no provider produced a stream', tried };
}
