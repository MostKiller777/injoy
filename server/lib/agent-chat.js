import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import * as catalog from './catalog.js';
import { addCustomFilm, curatedDetail, customFilmList, isCurated, removeCustomFilm } from './curated.js';
import { filmFromImdb, searchMovies } from './cinemeta.js';
import { repair, runDiagnostics } from './doctor.js';
import { seriesDetail, seriesItems } from './series.js';
import { mediaStats } from './media.js';
import { chromePath } from './resolver.js';
import { dataPath } from './paths.js';

/**
 * Admin chat agent.
 *
 * A deterministic command interpreter for the running site: it can run the
 * doctor, repair safe failures, search/add/remove films, list custom titles,
 * report stats/logs and make a small data backup. It has no shell and no remote
 * model; every action goes through the same checked helpers as the admin UI.
 */

const HELP = [
  'I can:',
  '• check the site — 20-point diagnosis',
  '• fix everything — repair safe failures',
  '• add The Matrix — search and add a film',
  '• search Dune — list matches without adding',
  '• remove <title> — remove a custom film (asks to confirm)',
  '• custom films — list added films',
  '• stats — catalogue, series, local media',
  '• logs — recent server log lines',
  '• backup — copy library/media/custom/key files',
  '• disk, cache, password, mentalist, chrome',
].join('\n');

const norm = (value) => String(value ?? '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ')
  .trim();

const humanBytes = (bytes) => {
  const n = Number(bytes) || 0;
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)} KB`;
  return `${n} B`;
};

const summary = (diagnosis) => `${diagnosis.summary.total} checks: ${diagnosis.summary.ok} ok, ${diagnosis.summary.warn} warning(s), ${diagnosis.summary.fail} failure(s).`;

function issues(diagnosis) {
  const list = diagnosis.checks.filter((check) => check.status !== 'ok');
  if (!list.length) return 'Everything is healthy.';
  return list.map((check) => `• ${check.label} — ${check.detail}${check.fixable ? ' (fixable)' : ''}`).join('\n');
}

async function addItem(item, cache) {
  if (!item?.imdbId) return { reply: 'That result has no IMDb id, so it cannot be added.' };
  let film;
  try {
    film = await filmFromImdb(item.imdbId);
  } catch (err) {
    return { reply: `Could not add “${item.title}”: ${err.message}` };
  }
  if (isCurated(film.tmdbId)) {
    const existing = curatedDetail(film.tmdbId);
    return {
      reply: `“${item.title}” is already in the catalogue.`,
      link: `#/movie/${encodeURIComponent(existing?.id ?? `tmdb:${film.tmdbId}`)}`,
      context: {},
    };
  }
  try {
    const added = addCustomFilm(film);
    cache?.clear?.();
    return {
      reply: `Added “${item.title}”${item.year ? ` (${item.year})` : ''}. It is live now.`,
      link: `#/movie/${encodeURIComponent(added.id)}`,
      refresh: true,
      context: {},
    };
  } catch (err) {
    return { reply: `Could not add “${item.title}”: ${err.message}` };
  }
}

async function search(query) {
  const words = String(query ?? '').trim().split(/\s+/).filter(Boolean);
  const attempts = [words.join(' ')];
  if (words.length > 4) {
    attempts.push(words.slice(-4).join(' '));
    attempts.push(words.slice(0, 4).join(' '));
  }
  const seen = new Set();
  const combined = [];
  let lastError = null;
  for (const attempt of attempts) {
    if (!attempt) continue;
    try {
      const results = await searchMovies(attempt);
      for (const item of results) {
        if (!item?.imdbId || seen.has(item.imdbId)) continue;
        seen.add(item.imdbId);
        combined.push(item);
        if (combined.length >= 8) break;
      }
    } catch (err) {
      lastError = err;
    }
    if (combined.length >= 8) break;
  }
  if (!combined.length && lastError) return { error: lastError.message };
  return combined.slice(0, 8);
}

function recentLogs() {
  for (const name of ['server-stderr.log', 'server-out.log']) {
    const file = dataPath('logs', name);
    if (!existsSync(file)) continue;
    try {
      const text = readFileSync(file, 'utf8').trim();
      if (!text) continue;
      return text.split(/\r?\n/).slice(-14).join('\n').slice(0, 2200);
    } catch {
      // try the next file
    }
  }
  return 'No local log files.';
}

function backupData() {
  const dir = dataPath('backups', new Date().toISOString().replace(/[:.]/g, '-'));
  mkdirSync(dir, { recursive: true });
  const copied = [];
  for (const name of ['library.json', 'media.json', 'custom-films.json', 'admin-key.txt']) {
    const source = dataPath(name);
    if (!existsSync(source)) continue;
    copyFileSync(source, join(dir, name));
    copied.push(name);
  }
  return { dir, copied };
}

export async function agentChat({ message, context = {}, cache = null, admin = {}, publicDir = join(process.cwd(), 'public') } = {}) {
  const text = String(message ?? '').trim().slice(0, 2_000);
  const lower = text.toLowerCase();
  const ctx = context && typeof context === 'object' ? context : {};

  if (!text) return { reply: 'Ask me something, or type “help”.', context: {} };

  if (/^(help|commands|what can you do|who are you)\b/i.test(text)) {
    return { reply: HELP, context: {} };
  }

  if (/^(yes|confirm|do it)\b/i.test(text) && ctx.pending?.type === 'remove') {
    const removed = removeCustomFilm(ctx.pending.tmdbId);
    if (removed) cache?.clear?.();
    return {
      reply: removed ? `Removed “${ctx.pending.title}”.` : 'That film is no longer in the custom list.',
      refresh: removed,
      context: {},
    };
  }

  if (/^(no|cancel|stop)\b/i.test(text)) {
    return { reply: 'Cancelled.', context: {} };
  }

  // Add by number from the previous search.
  const numericAdd = /^add\s+(?:number\s+)?(\d+)$/i.exec(text);
  if (numericAdd && Array.isArray(ctx.results) && ctx.results.length) {
    const item = ctx.results[Number(numericAdd[1]) - 1];
    if (!item) return { reply: `That list has ${ctx.results.length} results. Pick 1–${ctx.results.length}.`, context: ctx };
    return addItem(item, cache);
  }

  // Add by name.
  const addMatch = /^add\s+(.+)$/i.exec(text);
  if (addMatch) {
    let query = addMatch[1].trim().replace(/^(?:a\s+|an\s+|the\s+)?(?:movie|film|title)\s+/i, '').trim();
    if (!query) return { reply: 'Type the movie name, for example: add The Matrix', context: {} };
    const results = await search(query);
    if (results.error) return { reply: `Search failed: ${results.error}` };
    if (!results.length) return { reply: `I could not find “${query}”. Try a shorter title.`, context: {} };
    if (results.length === 1) return addItem(results[0], cache);
    const list = results.map((item, index) => `${index + 1}. ${item.title}${item.year ? ` (${item.year})` : ''}`).join('\n');
    return {
      reply: `I found these:\n${list}\n\nSay “add 2” to add one.`,
      context: { results },
    };
  }

  // Search only.
  const searchMatch = /^(?:search|find|look up)\s+(.+)$/i.exec(text);
  if (searchMatch) {
    const results = await search(searchMatch[1].trim());
    if (results.error) return { reply: `Search failed: ${results.error}` };
    if (!results.length) return { reply: `No match for “${searchMatch[1].trim()}”.`, context: {} };
    const list = results.map((item, index) => `${index + 1}. ${item.title}${item.year ? ` (${item.year})` : ''}`).join('\n');
    return { reply: `Matches:\n${list}\n\nSay “add 2” to add one.`, context: { results } };
  }

  // Remove a custom film.
  const removeMatch = /^(?:remove|delete|drop)\s+(.+)$/i.exec(text);
  if (removeMatch) {
    const query = norm(removeMatch[1]);
    const list = customFilmList();
    if (!list.length) return { reply: 'There are no custom films to remove.', context: {} };
    const matches = list.filter((item) => norm(item.title).includes(query));
    if (!matches.length) return { reply: `No custom film matches “${removeMatch[1]}”.`, context: {} };
    if (matches.length > 1) {
      return {
        reply: `Which one?\n${matches.map((item, index) => `${index + 1}. ${item.title}`).join('\n')}\n\nUse the exact title: remove ${matches[0].title}`,
        context: {},
      };
    }
    const item = matches[0];
    return {
      reply: `Remove “${item.title}” from the catalogue? Say “yes” to confirm.`,
      context: { pending: { type: 'remove', tmdbId: item.tmdbId, title: item.title } },
    };
  }

  if (/\b(fix|repair|solve|heal|clean)\b/i.test(lower)) {
    const result = await repair({ ids: [], cache, admin, publicDir });
    const fixed = result.fixed.length ? `Fixed: ${result.fixed.join(', ')}.` : 'There was nothing safe to fix.';
    const errors = result.errors.length ? `\nErrors: ${result.errors.map((entry) => `${entry.id} — ${entry.error}`).join('; ')}` : '';
    return {
      reply: `${fixed}${errors}\n${summary(result.diagnosis)}\n${issues(result.diagnosis)}`,
      refresh: true,
      context: {},
    };
  }

  if (/\b(check|diagnose|status|health|wrong|problem|doctor|broken|error)\b/i.test(lower)) {
    const diagnosis = await runDiagnostics({ cache, admin, publicDir });
    return {
      reply: `${summary(diagnosis)}\n${issues(diagnosis)}`,
      context: {},
    };
  }

  if (/\b(stats|statistics|catalog|catalogue|library|how many)\b/i.test(lower)) {
    const browse = await catalog.browse({ page: 1 });
    const shows = seriesItems();
    const episodes = shows.reduce((sum, show) => sum + (show.episodes ?? 0), 0);
    const custom = customFilmList();
    const media = mediaStats();
    return {
      reply: `Films: ${browse.total}\nSeries: ${shows.length} (${episodes.toLocaleString()} episodes)\nCustom films: ${custom.length}\nLocal media: ${media.count} (${humanBytes(media.bytes)})`,
      context: {},
    };
  }

  if (/\b(custom|added|my films)\b/i.test(lower)) {
    const list = customFilmList();
    if (!list.length) return { reply: 'No custom films yet. Say “add The Matrix”.', context: {} };
    return {
      reply: list.slice(0, 20).map((item) => `• ${item.title}${item.year ? ` (${item.year})` : ''} — ${item.id}`).join('\n'),
      context: {},
    };
  }

  if (/\b(log|logs|recent errors)\b/i.test(lower)) {
    return { reply: recentLogs(), context: {} };
  }

  if (/\b(backup|back up|save a copy)\b/i.test(lower)) {
    try {
      const result = backupData();
      return { reply: `Backup written to ${result.dir}\nCopied: ${result.copied.join(', ') || 'no data files'}`, context: {} };
    } catch (err) {
      return { reply: `Backup failed: ${err.message}`, context: {} };
    }
  }

  if (/\bcache\b/i.test(lower)) {
    if (/\b(clear|flush|empty|reset)\b/i.test(lower)) {
      cache?.clear?.();
      return { reply: 'Memory cache cleared.', context: {} };
    }
    const stats = cache?.stats?.();
    return { reply: stats ? `Cache: ${stats.size} entries, ${stats.hits} hits, ${stats.misses} misses.` : 'Cache stats are not available.', context: {} };
  }

  if (/\b(password|admin key|login)\b/i.test(lower)) {
    return {
      reply: `The admin password is ${admin.length ?? 0} characters (${admin.source ?? 'unknown'}). It is not printed in chat. ${admin.length < 8 ? 'Use 12+ characters on a public host.' : ''}`,
      context: {},
    };
  }

  if (/\b(mentalist|seasons|series)\b/i.test(lower)) {
    const mentalist = seriesDetail('tv:116');
    const seasons = mentalist?.seasons?.length ?? 0;
    const episodes = (mentalist?.seasons ?? []).reduce((sum, season) => sum + season.episodes.length, 0);
    return {
      reply: `The Mentalist: ${seasons} seasons, ${episodes} episodes. All ${episodes} rows are on the series page.`,
      link: '#/show/tv%3A116',
      context: {},
    };
  }

  if (/\b(caption|subtitles|cc)\b/i.test(lower)) {
    const diagnosis = await runDiagnostics({ cache, admin, publicDir });
    const check = diagnosis.checks.find((entry) => entry.id === 'subtitles');
    return { reply: check ? `${check.label}: ${check.detail}` : 'No caption check available.', context: {} };
  }

  if (/\b(chrome|resolver|playback|player)\b/i.test(lower)) {
    const chrome = chromePath();
    const media = mediaStats();
    return {
      reply: `Resolver browser: ${chrome || 'missing — embeds only'}\nLocal media: ${media.count} title(s), ${humanBytes(media.bytes)}`,
      context: {},
    };
  }

  if (/\b(disk|space|storage)\b/i.test(lower)) {
    const diagnosis = await runDiagnostics({ cache, admin, publicDir });
    const check = diagnosis.checks.find((entry) => entry.id === 'disk');
    return { reply: check ? `${check.label}: ${check.detail}` : 'No disk check available.', context: {} };
  }

  if (/\b(image|images|poster|posters|art)\b/i.test(lower)) {
    const diagnosis = await runDiagnostics({ cache, admin, publicDir });
    const check = diagnosis.checks.find((entry) => entry.id === 'images');
    return { reply: check ? `${check.label}: ${check.detail}` : 'No image check available.', context: {} };
  }

  if (/\b(home|films|series page|admin page|open)\b/i.test(lower)) {
    if (/\badmin\b/.test(lower)) return { reply: 'Admin panel is open.', link: '#/admin', context: {} };
    if (/\bhome\b/.test(lower)) return { reply: 'Home.', link: '#/', context: {} };
    return { reply: 'Series page.', link: '#/series', context: {} };
  }

  return {
    reply: `I did not catch that. Try “check the site”, “fix everything”, “add The Matrix”, “stats” or “help”.`,
    context: {},
  };
}
