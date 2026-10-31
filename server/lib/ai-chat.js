import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import * as catalog from './catalog.js';
import { addCustomFilm, customFilmList, isCurated, removeCustomFilm } from './curated.js';
import { filmFromImdb, searchMovies } from './cinemeta.js';
import { repair, runDiagnostics } from './doctor.js';
import { seriesItems } from './series.js';
import { mediaStats } from './media.js';
import { dataPath } from './paths.js';
import { aiConfig } from './ai.js';
import { toolCallFromContent } from './tool-call.js';

/**
 * Real AI agent, OpenAI-compatible.
 *
 * The model gets a small, explicit tool surface. Every action still runs through
 * the same server helpers as the admin UI: no shell, no file writes outside the
 * catalogue/data directory, and removal needs an explicit confirmation argument.
 */

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'diagnose_site',
      description: 'Run the full site doctor and return the summary plus every warning or failure.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fix_site',
      description: 'Repair every safe, known failure the doctor found.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_movies',
      description: 'Search the public movie index by title. Use this before add_movie.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Movie title to search for' } },
        required: ['query'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_movie',
      description: 'Add one movie to the catalogue by its IMDb id, taken from search_movies.',
      parameters: {
        type: 'object',
        properties: { imdbId: { type: 'string', description: 'IMDb id such as tt0133093' } },
        required: ['imdbId'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remove_movie',
      description: 'Remove a custom film. First call with confirm=false and ask the user; call again with confirm=true only after they agree.',
      parameters: {
        type: 'object',
        properties: {
          tmdbId: { type: 'integer', description: 'The custom film tmdbId' },
          confirm: { type: 'boolean', description: 'True only after the user confirmed removal' },
        },
        required: ['tmdbId', 'confirm'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_custom_films',
      description: 'List every film added through the admin panel.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_stats',
      description: 'Catalogue, series, custom-film and local-media counts.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_logs',
      description: 'Read the most recent local server log lines.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'backup_data',
      description: 'Copy library.json, media.json, custom-films.json and admin-key.txt into a timestamped backup directory.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'clear_cache',
      description: 'Clear the in-memory API cache.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'open_page',
      description: 'Return a link to a page so the admin can open it.',
      parameters: {
        type: 'object',
        properties: {
          page: {
            type: 'string',
            enum: ['home', 'films', 'series', 'genres', 'list', 'admin', 'mentalist'],
          },
        },
        required: ['page'],
        additionalProperties: false,
      },
    },
  },
];

const humanBytes = (bytes) => {
  const n = Number(bytes) || 0;
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)} KB`;
  return `${n} B`;
};

const recentLogs = () => {
  for (const name of ['server-stderr.log', 'server-out.log']) {
    const file = dataPath('logs', name);
    if (!existsSync(file)) continue;
    try {
      const text = readFileSync(file, 'utf8').trim();
      if (text) return text.split(/\r?\n/).slice(-14).join('\n').slice(0, 2200);
    } catch {
      // next file
    }
  }
  return 'No local log files.';
};

const backupData = () => {
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
};

const PAGE_LINKS = {
  home: '#/',
  films: '#/films',
  series: '#/series',
  genres: '#/genres',
  list: '#/list',
  admin: '#/admin',
  mentalist: '#/show/tv%3A116',
};

async function runTool(name, args, { cache, publicDir, admin }) {
  switch (name) {
    case 'diagnose_site': {
      const diagnosis = await runDiagnostics({ cache, admin, publicDir });
      return {
        ok: true,
        summary: diagnosis.summary,
        issues: diagnosis.checks.filter((check) => check.status !== 'ok').map((check) => ({
          id: check.id, label: check.label, status: check.status, detail: check.detail, fixable: check.fixable,
        })),
      };
    }
    case 'fix_site': {
      const result = await repair({ ids: [], cache, admin, publicDir });
      cache?.clear?.();
      return { ok: true, fixed: result.fixed, errors: result.errors, summary: result.diagnosis.summary, refresh: true };
    }
    case 'search_movies': {
      const results = await searchMovies(String(args.query ?? ''));
      const list = results.slice(0, 8).map(({ imdbId, title, year }) => ({ imdbId, title, year }));
      return { ok: true, results: list, context: { results: list } };
    }
    case 'add_movie': {
      const imdbId = String(args.imdbId ?? '').trim();
      if (!/^tt\d{5,}$/.test(imdbId)) return { ok: false, error: 'invalid IMDb id' };
      const film = await filmFromImdb(imdbId);
      if (isCurated(film.tmdbId)) {
        return {
          ok: true,
          already: true,
          title: film.title,
          link: `#/movie/${encodeURIComponent(`tmdb:${film.tmdbId}`)}`,
          context: {},
        };
      }
      const added = addCustomFilm(film);
      cache?.clear?.();
      return {
        ok: true,
        added: true,
        title: added.title,
        id: added.id,
        link: `#/movie/${encodeURIComponent(added.id)}`,
        refresh: true,
        context: {},
      };
    }
    case 'remove_movie': {
      const tmdbId = Number(args.tmdbId);
      const item = customFilmList().find((entry) => entry.tmdbId === tmdbId);
      if (!item) return { ok: false, error: 'no custom film with that tmdbId' };
      if (args.confirm !== true) {
        return {
          ok: false,
          needConfirmation: true,
          title: item.title,
          message: `Ask the user to confirm removing “${item.title}”, then call remove_movie with confirm=true.`,
          context: { pending: { type: 'remove', tmdbId: item.tmdbId, title: item.title } },
        };
      }
      const removed = removeCustomFilm(tmdbId);
      if (removed) cache?.clear?.();
      return { ok: removed, title: item.title, removed, refresh: removed, context: {} };
    }
    case 'list_custom_films': {
      return {
        ok: true,
        films: customFilmList().map(({ id, title, year, tmdbId }) => ({ id, title, year, tmdbId })),
      };
    }
    case 'get_stats': {
      const browse = await catalog.browse({ page: 1 });
      const shows = seriesItems();
      const episodes = shows.reduce((sum, show) => sum + (show.episodes ?? 0), 0);
      const media = mediaStats();
      return {
        ok: true,
        films: browse.total,
        series: shows.length,
        episodes,
        customFilms: customFilmList().length,
        localMedia: media.count,
        localBytes: humanBytes(media.bytes),
      };
    }
    case 'get_logs':
      return { ok: true, logs: recentLogs() };
    case 'backup_data': {
      const result = backupData();
      return { ok: true, directory: result.dir, copied: result.copied };
    }
    case 'clear_cache':
      cache?.clear?.();
      return { ok: true, cleared: true };
    case 'open_page': {
      const page = String(args.page ?? 'home');
      const link = PAGE_LINKS[page] ?? PAGE_LINKS.home;
      return { ok: true, page, link };
    }
    default:
      return { ok: false, error: `unknown tool: ${name}` };
  }
}

export async function aiChat({
  message,
  history = [],
  context = {},
  cache = null,
  admin = {},
  publicDir = join(process.cwd(), 'public'),
} = {}) {
  const config = aiConfig();
  if (!config) return null;

  const safeHistory = (Array.isArray(history) ? history : [])
    .filter((entry) => (entry?.role === 'user' || entry?.role === 'assistant') && entry.content)
    .slice(-10)
    .map((entry) => ({ role: entry.role, content: String(entry.content).slice(0, 4_000) }));

  const system = [
    'You are Injoy Agent, the private administrator assistant for a self-hosted streaming catalogue.',
    'You can call tools to diagnose and repair the site, search/add/remove custom films, list custom films, read stats and logs, back up data, clear the cache and open pages.',
    'Rules:',
    '- Be concise and practical. Use tools for facts and actions; never invent catalogue data.',
    '- Before removing a film, ask the user to confirm. Only call remove_movie with confirm=true after they say yes.',
    '- Never reveal the admin password or any API key.',
    '- Never claim shell access. You cannot run arbitrary commands.',
    '- After an action, state the result and include the link the tool returned.',
    `The admin password is ${admin.length ?? 0} characters long (${admin.source ?? 'unknown'}); do not print it.`,
    context && Object.keys(context).length
      ? `Structured context from earlier turns: ${JSON.stringify(context).slice(0, 3_000)}`
      : '',
  ].filter(Boolean).join('\n');

  const messages = [
    { role: 'system', content: system },
    ...safeHistory,
    { role: 'user', content: String(message ?? '').slice(0, 4_000) },
  ];

  let nextContext = context && typeof context === 'object' ? { ...context } : {};
  let refresh = false;
  let link = null;

  for (let round = 0; round < 4; round += 1) {
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.key}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages,
        tools: TOOLS,
        tool_choice: 'auto',
        temperature: 0.2,
      }),
      signal: AbortSignal.timeout(180_000),
    });

    const text = await response.text();
    if (!response.ok) throw new Error(`AI provider ${response.status}: ${text.slice(0, 300)}`);

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error('AI provider returned invalid JSON');
    }

    const choice = data.choices?.[0]?.message;
    if (!choice) throw new Error('AI provider returned no message');
    const explicitCalls = Array.isArray(choice.tool_calls) ? choice.tool_calls : [];
    const implicit = explicitCalls.length ? null : toolCallFromContent(choice.content);
    const calls = explicitCalls.length
      ? explicitCalls
      : implicit
        ? [{
            id: `implicit_${round}`,
            type: 'function',
            function: { name: implicit.name, arguments: JSON.stringify(implicit.arguments) },
          }]
        : [];

    if (!calls.length) {
      return {
        reply: String(choice.content ?? '').trim() || 'Done.',
        link,
        refresh,
        context: nextContext,
      };
    }

    // A model that emitted the call as text gets it executed; the raw JSON is
    // never shown to the admin as the final answer.
    messages.push({
      role: 'assistant',
      content: explicitCalls.length ? (choice.content ?? null) : null,
      tool_calls: calls,
    });
    for (const call of calls) {
      let args = {};
      try {
        args = JSON.parse(call.function?.arguments ?? '{}');
      } catch {
        args = {};
      }
      let result;
      try {
        result = await runTool(call.function?.name, args, { cache, publicDir, admin });
      } catch (err) {
        result = { ok: false, error: err.message };
      }
      if (result.refresh) refresh = true;
      if (result.link) link = result.link;
      if (Object.prototype.hasOwnProperty.call(result, 'context')) nextContext = result.context ?? {};
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify(result),
      });
    }
  }

  return {
    reply: 'I stopped after several tool steps. Try a narrower request.',
    link,
    refresh,
    context: nextContext,
  };
}
