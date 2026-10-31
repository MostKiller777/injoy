import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { statfs } from 'node:fs/promises';
import { basename, join } from 'node:path';

import * as catalog from './catalog.js';
import { reloadCustomFilms } from './curated.js';
import { seriesDetail, seriesItems, seriesStreamTarget } from './series.js';
import { subtitleTracks } from './subtitles.js';
import { chromePath } from './resolver.js';
import { mediaStats } from './media.js';
import { dataPath, dataRoot } from './paths.js';
import { isAllowedImage, optimizeImageUrl } from './images.js';
import { searchMovies } from './cinemeta.js';

/**
 * Admin-only site doctor.
 *
 * This is deliberately a rule-based agent, not a remote LLM: it can inspect the
 * running machine, read the data files, probe the public metadata sources and
 * repair a small, known set of failures. Nothing here executes arbitrary code.
 */

const EXPECTED_GENRES = ['noir', 'horror', 'scifi', 'comedy', 'drama', 'western', 'animation', 'documentary'];

function withTimeout(task, ms, fallback) {
  let timer = null;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
    timer.unref?.();
  });
  return Promise.race([task, deadline]).finally(() => clearTimeout(timer));
}

const humanBytes = (bytes) => {
  const n = Number(bytes) || 0;
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)} KB`;
  return `${n} B`;
};

function walk(dir, predicate = () => true, depth = 0) {
  if (depth > 5 || !existsSync(dir)) return [];
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, predicate, depth + 1));
    else if (entry.isFile() && predicate(full)) out.push(full);
  }
  return out;
}

function validCustom(raw) {
  if (!raw || typeof raw !== 'object') return false;
  const id = Number(raw.tmdbId ?? String(raw.id ?? '').replace(/^tmdb:/i, ''));
  if (!Number.isFinite(id) || id <= 0) return false;
  if (!String(raw.title ?? '').trim()) return false;
  if (raw.year != null && !Number.isFinite(Number(raw.year))) return false;
  if (raw.runtime != null && !Number.isFinite(Number(raw.runtime))) return false;
  if (raw.genres != null && !Array.isArray(raw.genres)) return false;
  return true;
}

function backup(file) {
  const target = `${file}.bak-${Date.now()}`;
  renameSync(file, target);
  return target;
}

/* --------------------------------- checks --------------------------------- */

export async function runDiagnostics({ cache = null, admin = {}, publicDir = join(process.cwd(), 'public') } = {}) {
  const checks = [];
  const add = (id, label, status, detail, fixable = false) => {
    checks.push({ id, label, status, detail, fixable });
  };

  // Runtime
  const major = Number(process.versions.node.split('.')[0]);
  add('node', 'Node runtime', major >= 20 ? 'ok' : 'warn',
    `${process.versions.node}${major >= 20 ? '' : ' — Node 20 or newer is required'}`);

  const rss = process.memoryUsage().rss;
  add('memory', 'Server memory', rss > 2.5e9 ? 'fail' : rss > 1.5e9 ? 'warn' : 'ok',
    `${humanBytes(rss)} resident · uptime ${Math.round(process.uptime() / 60)} min`);

  // Data directory and files
  const root = dataRoot();
  let dataWritable = true;
  try {
    mkdirSync(root, { recursive: true });
    const probe = dataPath(`.doctor-${process.pid}`);
    writeFileSync(probe, 'ok');
    unlinkSync(probe);
  } catch {
    dataWritable = false;
  }
  add('data-dir', 'Data directory', dataWritable ? 'ok' : 'fail',
    dataWritable ? root : `${root} is not writable`, !dataWritable);

  const dataFiles = [];
  for (const name of ['library.json', 'media.json']) {
    const file = dataPath(name);
    if (!existsSync(file)) continue;
    try {
      JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      dataFiles.push(name);
    }
  }
  add('data-files', 'Library and media index', dataFiles.length ? 'fail' : 'ok',
    dataFiles.length
      ? `${dataFiles.join(', ')} cannot be parsed — restore a backup before writing`
      : 'library.json and media.json parse cleanly');

  // Custom films
  const customFile = dataPath('custom-films.json');
  let customIssue = null;
  let customCount = 0;
  if (existsSync(customFile)) {
    try {
      const parsed = JSON.parse(readFileSync(customFile, 'utf8'));
      const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.films) ? parsed.films : null;
      if (!list) {
        customIssue = 'the file is not an array of films';
      } else {
        customCount = list.length;
        const invalid = list.filter((entry) => !validCustom(entry)).length;
        const ids = list.map((entry) => Number(entry?.tmdbId)).filter((id) => Number.isFinite(id));
        const duplicates = ids.length - new Set(ids).size;
        if (invalid) customIssue = `${invalid} invalid record(s)`;
        else if (duplicates) customIssue = `${duplicates} duplicate TMDB id(s)`;
      }
    } catch {
      customIssue = 'the file is not valid JSON';
    }
  }
  add('custom-films', 'Custom film file',
    customIssue ? 'warn' : 'ok',
    customIssue ? `${customIssue} — fix rewrites a backup and keeps the valid records` : customCount ? `${customCount} custom film(s)` : 'No custom films yet',
    Boolean(customIssue));

  // Catalogue
  try {
    const home = await catalog.home();
    const browse = await catalog.browse({ page: 1 });
    const genreData = await catalog.genres();
    const ids = (genreData.genres ?? []).map((genre) => genre.id);
    const missing = EXPECTED_GENRES.filter((id) => !ids.includes(id));
    const rails = (home.rows ?? []).map((row) => String(row.key ?? '')).filter((key) => key.startsWith('genre-')).map((key) => key.slice(6));
    const ordered = JSON.stringify(rails) === JSON.stringify(EXPECTED_GENRES);
    if (!browse.total) add('catalog', 'Catalogue', 'fail', 'No films are loaded');
    else if (missing.length || !ordered) {
      add('catalog', 'Catalogue', 'warn',
        `${browse.total} films; missing genres: ${missing.join(', ') || 'none'}; rail order ${ordered ? 'ok' : 'wrong'}`);
    } else {
      add('catalog', 'Catalogue', 'ok', `${browse.total} films · ${ids.length} genres · rails in order`);
    }
  } catch (err) {
    add('catalog', 'Catalogue', 'fail', err.message);
  }

  // Series
  try {
    const items = seriesItems();
    const mentalist = seriesDetail('tv:116');
    const seasons = mentalist?.seasons?.length ?? 0;
    const episodes = (mentalist?.seasons ?? []).reduce((sum, season) => sum + season.episodes.length, 0);
    if (!items.length) add('series', 'Series catalogue', 'fail', 'No series are loaded');
    else if (seasons !== 7 || episodes !== 151) add('series', 'Series catalogue', 'warn', `${items.length} shows; The Mentalist is ${seasons} seasons / ${episodes} episodes`);
    else add('series', 'Series catalogue', 'ok', `${items.length} shows · The Mentalist 7 seasons / 151 episodes`);
  } catch (err) {
    add('series', 'Series catalogue', 'fail', err.message);
  }

  // Admin auth
  const keyLength = Number(admin.length) || 0;
  add('admin', 'Admin password',
    keyLength === 0 ? 'fail' : keyLength < 8 ? 'warn' : 'ok',
    keyLength === 0 ? 'No admin password configured' : `${keyLength} characters (${admin.source ?? 'unknown'}); ${keyLength < 8 ? 'use 12+ on a public host' : 'no action needed'}`);

  // Resolver browser
  const chrome = chromePath();
  add('chrome', 'Resolver browser', chrome ? 'ok' : 'warn',
    chrome ? basename(chrome) : 'No Chrome/Chromium — direct streams fall back to embeds');

  // Local media
  const media = mediaStats();
  add('local-media', 'Local media cache',
    media.count ? 'ok' : 'warn',
    media.count ? `${media.count} title(s) · ${humanBytes(media.bytes)}` : 'No local copies yet — live streams and embeds still work');

  // Image proxy rewriting
  try {
    const tmdb = optimizeImageUrl('https://image.tmdb.org/t/p/w500/x.jpg');
    const letterboxd = optimizeImageUrl('https://a.ltrbxd.com/resized/film-poster/1/1/1/1/111-film-0-1000-0-1500-crop.jpg?v=1');
    const allowed = isAllowedImage('https://images.metahub.space/poster/small/tt0111161/img');
    const good = tmdb.includes('/w342/') && letterboxd.includes('-0-400-0-600-crop') && allowed;
    add('images', 'Image pipeline', good ? 'ok' : 'fail',
      good ? 'TMDB, Letterboxd and Metahub card art all rewrite correctly' : 'Card art rewriting is not returning the expected URLs');
  } catch (err) {
    add('images', 'Image pipeline', 'fail', err.message);
  }

  // Cinemeta search
  try {
    const results = await withTimeout(searchMovies('inception'), 8_000, null);
    if (!results) add('cinemeta', 'Cinemeta search', 'warn', 'Search timed out; the admin Add button may be slow');
    else if (!results.length) add('cinemeta', 'Cinemeta search', 'warn', 'Search returned no results');
    else add('cinemeta', 'Cinemeta search', 'ok', `${results.length} results for “inception”`);
  } catch (err) {
    add('cinemeta', 'Cinemeta search', 'warn', `Unavailable: ${err.message}`);
  }

  // Subtitle index
  try {
    const target = seriesStreamTarget('tv:116:1:1');
    const list = target
      ? await withTimeout(subtitleTracks({
          id: 'tv:116:1:1',
          title: target.title,
          year: null,
          imdbId: target.imdbId,
          season: 1,
          episode: 1,
          duration: target.duration,
        }), 10_000, null)
      : null;
    if (!list) add('subtitles', 'Subtitle index', 'warn', 'Subtitle lookup timed out');
    else if (!list.tracks?.length) add('subtitles', 'Subtitle index', 'warn', 'No caption tracks returned for The Mentalist S1E1');
    else add('subtitles', 'Subtitle index', 'ok', `${list.tracks.length} caption languages for The Mentalist S1E1`);
  } catch (err) {
    add('subtitles', 'Subtitle index', 'warn', `Unavailable: ${err.message}`);
  }

  // Service worker shell
  const swFile = join(publicDir, 'sw.js');
  if (!existsSync(swFile)) {
    add('service-worker', 'Service worker', 'fail', 'public/sw.js is missing');
  } else {
    try {
      const source = readFileSync(swFile, 'utf8');
      const version = /VERSION\s*=\s*'([^']+)'/.exec(source)?.[1] ?? 'unknown';
      const shellBlock = /const SHELL\s*=\s*\[([\s\S]*?)\];/.exec(source)?.[1] ?? '';
      const shell = [...shellBlock.matchAll(/'([^']+)'/g)].map((match) => match[1]);
      const missing = shell.filter((entry) => !existsSync(join(publicDir, entry.replace(/^\//, ''))));
      add('service-worker', 'Service worker', missing.length ? 'fail' : 'ok',
        missing.length ? `${version}: missing ${missing.join(', ')}` : `${version} · ${shell.length} shell files present`);
    } catch (err) {
      add('service-worker', 'Service worker', 'fail', err.message);
    }
  }

  // Static assets
  const assets = ['index.html', 'js/app.js', 'js/player.js', 'css/app.css'];
  const missingAssets = assets.filter((entry) => !existsSync(join(publicDir, entry)));
  add('static-assets', 'Static assets', missingAssets.length ? 'fail' : 'ok',
    missingAssets.length ? `Missing ${missingAssets.join(', ')}` : `${assets.length} core assets present`);

  // Disk
  try {
    const space = await statfs(root);
    const free = Number(space.bavail) * Number(space.bsize);
    add('disk', 'Disk space', free < 512e6 ? 'fail' : free < 2e9 ? 'warn' : 'ok',
      `${humanBytes(free)} free on the data volume`);
  } catch {
    add('disk', 'Disk space', 'warn', 'Could not read free disk space on this platform');
  }

  // Logs
  const logDir = dataPath('logs');
  const logFiles = existsSync(logDir) ? walk(logDir, (file) => file.endsWith('.log')) : [];
  let logBytes = 0;
  let logErrors = 0;
  for (const file of logFiles) {
    try {
      const size = statSync(file).size;
      logBytes += size;
      const tail = readFileSync(file, 'utf8').slice(-20_000);
      logErrors += (tail.match(/\b(?:ERROR|Error| 500 | 502 |EADDRINUSE)\b/g) ?? []).length;
    } catch {
      // unreadable log is not a site failure
    }
  }
  if (logBytes > 20e6) add('logs', 'Server logs', 'warn', `${humanBytes(logBytes)} across ${logFiles.length} file(s) — fix keeps the last 200 lines`, true);
  else if (logErrors) add('logs', 'Server logs', 'warn', `${logErrors} recent error line(s) in ${humanBytes(logBytes)} of logs`);
  else add('logs', 'Server logs', 'ok', logFiles.length ? `${logFiles.length} file(s), ${humanBytes(logBytes)}` : 'No local log files');

  // Temporary downloads
  const tempFiles = [
    ...walk(dataPath('media'), (file) => /\.(?:part|tmp)$/i.test(file) && Date.now() - statSync(file).mtimeMs > 24 * 60 * 60_000),
    ...walk(root, (file) => file.endsWith('.tmp') && Date.now() - statSync(file).mtimeMs > 60 * 60_000),
  ];
  add('temp-files', 'Temporary files', tempFiles.length ? 'warn' : 'ok',
    tempFiles.length ? `${tempFiles.length} stale part/tmp file(s)` : 'No stale temporary files', tempFiles.length > 0);

  // Converted subtitle cache
  const badSubs = walk(dataPath('subs'), (file) => file.endsWith('.vtt')).filter((file) => {
    try {
      return !/^WEBVTT/.test(readFileSync(file, 'utf8').trimStart());
    } catch {
      return true;
    }
  });
  add('subs-cache', 'Caption cache', badSubs.length ? 'warn' : 'ok',
    badSubs.length ? `${badSubs.length} converted file(s) are not WebVTT` : 'Converted captions are valid WebVTT', badSubs.length > 0);

  // In-memory cache
  const stats = cache?.stats?.();
  add('cache', 'Memory cache', stats && stats.size > 1200 ? 'warn' : 'ok',
    stats ? `${stats.size} entries · ${stats.hits} hits / ${stats.misses} misses` : 'Cache not exposed', Boolean(stats && stats.size > 1200));

  const summary = {
    total: checks.length,
    ok: checks.filter((check) => check.status === 'ok').length,
    warn: checks.filter((check) => check.status === 'warn').length,
    fail: checks.filter((check) => check.status === 'fail').length,
    fixable: checks.filter((check) => check.fixable && check.status !== 'ok').length,
  };

  return {
    ok: summary.fail === 0,
    checkedAt: new Date().toISOString(),
    summary,
    checks,
  };
}

/* --------------------------------- repairs -------------------------------- */

function fixCustomFilms() {
  const file = dataPath('custom-films.json');
  if (!existsSync(file)) {
    writeFileSync(file, '[]\n', 'utf8');
    reloadCustomFilms();
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    backup(file);
    writeFileSync(file, '[]\n', 'utf8');
    reloadCustomFilms();
    return;
  }
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.films) ? parsed.films : [];
  const seen = new Set();
  const valid = [];
  for (const entry of list) {
    if (!validCustom(entry)) continue;
    const id = Number(entry.tmdbId ?? String(entry.id ?? '').replace(/^tmdb:/i, ''));
    if (seen.has(id)) continue;
    seen.add(id);
    valid.push({
      ...entry,
      tmdbId: id,
      title: String(entry.title).trim(),
      genres: Array.isArray(entry.genres) ? entry.genres : [],
      poster: entry.poster ?? entry.posterUrl ?? null,
      backdrop: entry.backdrop ?? entry.backdropUrl ?? null,
    });
  }
  backup(file);
  writeFileSync(file, `${JSON.stringify(valid, null, 2)}\n`, 'utf8');
  reloadCustomFilms();
}

function fixLogs() {
  const logDir = dataPath('logs');
  for (const file of walk(logDir, (entry) => entry.endsWith('.log'))) {
    try {
      if (statSync(file).size <= 5e6) continue;
      const lines = readFileSync(file, 'utf8').split(/\r?\n/);
      writeFileSync(file, `${lines.slice(-200).join('\n')}\n`, 'utf8');
    } catch {
      // a log that cannot be truncated is not worth failing the repair
    }
  }
}

function fixTemp() {
  const files = [
    ...walk(dataPath('media'), (file) => /\.(?:part|tmp)$/i.test(file) && Date.now() - statSync(file).mtimeMs > 24 * 60 * 60_000),
    ...walk(dataRoot(), (file) => file.endsWith('.tmp') && Date.now() - statSync(file).mtimeMs > 60 * 60_000),
  ];
  for (const file of files) {
    try { unlinkSync(file); } catch { /* still locked */ }
  }
}

function fixSubs() {
  const files = walk(dataPath('subs'), (file) => file.endsWith('.vtt')).filter((file) => {
    try {
      return !/^WEBVTT/.test(readFileSync(file, 'utf8').trimStart());
    } catch {
      return true;
    }
  });
  for (const file of files) {
    try { unlinkSync(file); } catch { /* already gone */ }
  }
}

export async function repair({ ids = [], cache = null, admin = {}, publicDir = join(process.cwd(), 'public') } = {}) {
  const before = await runDiagnostics({ cache, admin, publicDir });
  const wanted = new Set(Array.isArray(ids) ? ids : []);
  const targets = before.checks.filter((check) => check.fixable && check.status !== 'ok'
    && (!wanted.size || wanted.has(check.id)));

  const fixed = [];
  const errors = [];
  for (const check of targets) {
    try {
      if (check.id === 'data-dir') {
        mkdirSync(dataRoot(), { recursive: true });
      } else if (check.id === 'custom-films') {
        fixCustomFilms();
        cache?.clear?.();
      } else if (check.id === 'logs') {
        fixLogs();
      } else if (check.id === 'temp-files') {
        fixTemp();
      } else if (check.id === 'subs-cache') {
        fixSubs();
      } else if (check.id === 'cache') {
        cache?.clear?.();
      } else {
        continue;
      }
      fixed.push(check.id);
    } catch (err) {
      errors.push({ id: check.id, error: err.message });
    }
  }

  const diagnosis = await runDiagnostics({ cache, admin, publicDir });
  return { fixed, errors, diagnosis };
}
