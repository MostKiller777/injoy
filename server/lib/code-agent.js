import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';

import { APP_ROOT, dataPath } from './paths.js';
import { aiConfig } from './ai.js';
import { runDiagnostics } from './doctor.js';
import { toolCallFromContent } from './tool-call.js';

/**
 * Admin-only code agent.
 *
 * It can inspect the project and propose edits, but it never writes a file
 * itself: every change is stored as a pending edit, shown as a diff, and applied
 * only when the admin presses Apply. Apply backs up the old file and runs a
 * syntax check; a failed check rolls the file back.
 */

const ALLOWED_ROOTS = ['server/', 'public/', 'deploy/', 'scripts/', 'publish/'];
const ALLOWED_FILES = new Set(['README.md', 'package.json', '.env.example', '.gitignore', '.gitattributes']);
const TEXT_EXT = new Set([
  '.js', '.mjs', '.cjs', '.css', '.html', '.json', '.md', '.sh', '.ps1',
  '.vbs', '.yaml', '.yml', '.txt', '.service', '.svg', '.webmanifest',
]);
const BLOCKED = /^(?:\.git|data|node_modules)(?:\/|$)/i;
const MAX_READ = 140_000;
const MAX_WRITE = 400_000;
const PENDING_TTL = 60 * 60_000;

const pending = new Map();

function isText(rel) {
  if (ALLOWED_FILES.has(rel)) return true;
  return TEXT_EXT.has(extname(rel).toLowerCase());
}

function safePath(input) {
  const raw = String(input ?? '').trim().replace(/\\/g, '/').replace(/^\.?\//, '');
  if (!raw) throw Object.assign(new Error('a path is required'), { status: 400 });
  if (raw.includes('..') || raw.startsWith('/') || BLOCKED.test(raw) || raw === '.env') {
    throw Object.assign(new Error('that path is outside the editable project files'), { status: 400 });
  }
  const abs = resolve(APP_ROOT, raw);
  const rel = relative(APP_ROOT, abs).replace(/\\/g, '/');
  if (rel.startsWith('..') || rel === '' || !(ALLOWED_ROOTS.some((root) => rel.startsWith(root)) || ALLOWED_FILES.has(rel))) {
    throw Object.assign(new Error('that path is outside the editable project files'), { status: 400 });
  }
  if (!isText(rel)) throw Object.assign(new Error('only text project files can be read or edited'), { status: 400 });
  return { abs, rel };
}

function safeDir(input) {
  const raw = String(input ?? '').trim().replace(/\\/g, '/').replace(/^\.?\//, '');
  if (!raw) throw Object.assign(new Error('a path is required'), { status: 400 });
  if (raw.includes('..') || raw.startsWith('/') || BLOCKED.test(raw) || raw === '.env') {
    throw Object.assign(new Error('that path is outside the editable project files'), { status: 400 });
  }
  const abs = resolve(APP_ROOT, raw);
  const rel = relative(APP_ROOT, abs).replace(/\\/g, '/');
  if (rel.startsWith('..') || rel === '' || !ALLOWED_ROOTS.some((root) => rel.startsWith(root))) {
    throw Object.assign(new Error('that path is outside the editable project files'), { status: 400 });
  }
  return { abs, rel };
}

function listFiles(path = '.') {
  const raw = String(path ?? '.').trim().replace(/\\/g, '/');
  if (raw === '.' || raw === '') {
    const out = [];
    for (const name of readdirSync(APP_ROOT, { withFileTypes: true })) {
      if (BLOCKED.test(name.name) || name.name === '.env') continue;
      if (name.isDirectory()) out.push(`${name.name}/`);
      else if (isText(name.name)) out.push(name.name);
    }
    return out.sort().slice(0, 200);
  }
  const { abs, rel } = safeDir(raw);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) {
    throw Object.assign(new Error('not a directory'), { status: 400 });
  }
  const out = [];
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    if (BLOCKED.test(`${rel}/${entry.name}`) || entry.name === '.env') continue;
    if (entry.isDirectory()) out.push(`${rel}/${entry.name}/`);
    else if (isText(`${rel}/${entry.name}`)) out.push(`${rel}/${entry.name}`);
  }
  return out.sort().slice(0, 200);
}

function readProjectFile(path) {
  const { abs, rel } = safePath(path);
  if (!existsSync(abs)) throw Object.assign(new Error('file not found'), { status: 404 });
  const size = statSync(abs).size;
  if (size > MAX_READ) throw Object.assign(new Error(`file is larger than ${MAX_READ} bytes`), { status: 413 });
  return { path: rel, content: readFileSync(abs, 'utf8') };
}

function searchProject(query, path = '.') {
  const needle = String(query ?? '').trim();
  if (needle.length < 2) throw Object.assign(new Error('search needs at least two characters'), { status: 400 });
  const roots = path && path !== '.' ? [safePath(path).abs] : ALLOWED_ROOTS.map((root) => resolve(APP_ROOT, root));
  const matches = [];
  const visit = (dir, depth = 0) => {
    if (depth > 6 || !existsSync(dir)) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (matches.length >= 40) return;
      const full = join(dir, entry.name);
      const rel = relative(APP_ROOT, full).replace(/\\/g, '/');
      if (BLOCKED.test(rel) || entry.name === '.env') continue;
      if (entry.isDirectory()) {
        visit(full, depth + 1);
        continue;
      }
      if (!isText(rel) || statSync(full).size > 250_000) continue;
      let text;
      try { text = readFileSync(full, 'utf8'); } catch { continue; }
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length && matches.length < 40; i += 1) {
        if (lines[i].toLowerCase().includes(needle.toLowerCase())) {
          matches.push({ path: rel, line: i + 1, text: lines[i].slice(0, 220) });
        }
      }
    }
  };
  for (const root of roots) visit(root);
  return matches;
}

function diffLines(before, after) {
  const a = String(before ?? '').split('\n');
  const b = String(after ?? '').split('\n');
  const output = ['--- a', '+++ b'];
  if (a.length > 900 || b.length > 900 || a.length * b.length > 800_000) {
    output.push(`@@ ${a.length} lines -> ${b.length} lines (file too large for a line diff)`);
    return output.join('\n');
  }
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dp = Array.from({ length: rows }, () => new Uint16Array(cols));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      output.push(` ${a[i]}`);
      i += 1;
      j += 1;
    } else if (j < b.length && (i >= a.length || dp[i][j + 1] >= dp[i + 1][j])) {
      output.push(`+${b[j]}`);
      j += 1;
    } else {
      output.push(`-${a[i]}`);
      i += 1;
    }
  }
  return output.join('\n');
}

function proposeEdit({ path, content, summary = '' }) {
  const { abs, rel } = safePath(path);
  const text = String(content ?? '');
  if (text.length > MAX_WRITE) throw Object.assign(new Error('proposed file is too large'), { status: 413 });
  const before = existsSync(abs) ? readFileSync(abs, 'utf8') : '';
  const id = randomUUID();
  const now = Date.now();
  pending.set(id, { id, path: rel, before, content: text, summary: String(summary ?? ''), at: now });
  for (const [key, edit] of pending) if (now - edit.at > PENDING_TTL) pending.delete(key);
  return {
    id,
    path: rel,
    summary: String(summary ?? ''),
    diff: diffLines(before, text),
    linesBefore: before.split('\n').length,
    linesAfter: text.split('\n').length,
  };
}

function checkFile(abs, rel) {
  const ext = extname(rel).toLowerCase();
  if (ext === '.json') {
    try {
      JSON.parse(readFileSync(abs, 'utf8'));
      return { ok: true, detail: 'JSON parses' };
    } catch (err) {
      return { ok: false, detail: err.message };
    }
  }
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
    const result = spawnSync(process.execPath, ['--check', abs], { encoding: 'utf8', timeout: 15_000 });
    return {
      ok: result.status === 0,
      detail: (result.stderr || result.stdout || '').trim().slice(0, 2_000) || (result.status === 0 ? 'syntax OK' : 'syntax check failed'),
    };
  }
  return { ok: true, detail: 'no syntax checker for this file type' };
}

export function applyCodeEdit(id) {
  const edit = pending.get(String(id));
  if (!edit) return { ok: false, status: 404, error: 'that proposed edit has expired' };

  const { abs, rel } = safePath(edit.path);
  const backupDir = dataPath('backups', 'code', new Date().toISOString().replace(/[:.]/g, '-'));
  mkdirSync(backupDir, { recursive: true });
  const backup = join(backupDir, rel.replace(/\//g, '__'));
  if (existsSync(abs)) copyFileSync(abs, backup);

  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, edit.content, 'utf8');

  const check = checkFile(abs, rel);
  if (!check.ok) {
    if (edit.before) writeFileSync(abs, edit.before, 'utf8');
    else if (existsSync(abs)) unlinkSync(abs);
    return {
      ok: false,
      status: 422,
      error: `syntax check failed; file restored: ${check.detail}`,
      check,
      path: rel,
    };
  }

  pending.delete(String(id));
  return {
    ok: true,
    path: rel,
    check,
    backup,
    restartRequired: rel.startsWith('server/') || rel === 'package.json',
  };
}

export function rejectCodeEdit(id) {
  return { ok: pending.delete(String(id)) };
}

/* --------------------------------- tools ---------------------------------- */

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'List files in a project directory. Use "." for the repository root.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Relative directory, default .' } },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a text file under server/, public/, deploy/, scripts/ or publish/ (or README/package.json).',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_files',
      description: 'Case-insensitive text search across the project. Returns path, line and text.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          path: { type: 'string', description: 'Optional directory to limit the search' },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'propose_edit',
      description: 'Propose a full replacement for a project text file. This does NOT write; the admin sees a diff and Apply button.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string', description: 'Complete new file content' },
          summary: { type: 'string', description: 'One-line description of the change' },
        },
        required: ['path', 'content', 'summary'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_check',
      description: 'Run the syntax check for a project file: node --check for JS, JSON.parse for JSON.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'site_doctor',
      description: 'Run the live site doctor and return its summary and non-ok checks.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_logs',
      description: 'Read the most recent local server log lines.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
];

async function runTool(name, args, { cache, admin, publicDir }) {
  switch (name) {
    case 'list_files':
      return { ok: true, files: listFiles(args.path ?? '.') };
    case 'read_file':
      return { ok: true, ...readProjectFile(args.path) };
    case 'search_files':
      return { ok: true, matches: searchProject(args.query, args.path) };
    case 'propose_edit':
      return { ok: true, edit: proposeEdit(args) };
    case 'run_check': {
      const { abs, rel } = safePath(args.path);
      if (!existsSync(abs)) return { ok: false, error: 'file not found' };
      return { ok: true, path: rel, check: checkFile(abs, rel) };
    }
    case 'site_doctor': {
      const diagnosis = await runDiagnostics({ cache, admin, publicDir });
      return {
        ok: true,
        summary: diagnosis.summary,
        issues: diagnosis.checks.filter((check) => check.status !== 'ok').map((check) => ({
          id: check.id, label: check.label, status: check.status, detail: check.detail, fixable: check.fixable,
        })),
      };
    }
    case 'read_logs': {
      for (const file of ['server-stderr.log', 'server-out.log']) {
        const full = dataPath('logs', file);
        if (!existsSync(full)) continue;
        try {
          const text = readFileSync(full, 'utf8').trim();
          if (text) return { ok: true, logs: text.split(/\r?\n/).slice(-14).join('\n').slice(0, 2_000) };
        } catch {
          // next
        }
      }
      return { ok: true, logs: 'No local log files.' };
    }
    default:
      return { ok: false, error: `unknown tool: ${name}` };
  }
}

/**
 * Deterministic file browsing.
 *
 * Small local models are unreliable at choosing tools for simple "list/read/
 * search/check" requests. Those requests have one correct answer, so answer
 * them directly and leave the model for changes and explanations.
 */
async function directCodeRequest(message, { cache, admin, publicDir }) {
  const text = String(message ?? '').trim();
  const lower = text.toLowerCase();
  if (!text) return null;
  // Edits/explanations go to the model.
  if (/\b(edit|change|update|fix|improve|rewrite|refactor|propose|add|remove|delete|why|bug)\b/i.test(text)) return null;

  const listMatch = /\b(?:list|show)\s+(?:the\s+)?(?:files?|directory)\b(?:\s+(?:in|at|under)\s+([a-z0-9_./-]+))?/i.exec(text);
  if (listMatch) {
    try {
      const path = (listMatch[1] ?? '.').replace(/[.,;]+$/, '');
      const files = listFiles(path);
      return {
        mode: 'direct',
        reply: files.length ? `Files in ${path}:\n${files.join('\n')}` : `${path} is empty or has no text files.`,
        edits: [],
      };
    } catch (err) {
      return { mode: 'direct', reply: err.message, edits: [] };
    }
  }

  const readMatch = /\b(?:read|open|show|cat)\s+(?:the\s+)?(?:file\s+)?([a-z0-9_./-]+\.(?:js|mjs|cjs|css|html|json|md|sh|ps1|vbs|yaml|yml|txt|service|svg))\b/i.exec(text);
  if (readMatch) {
    try {
      const file = readProjectFile(readMatch[1]);
      return {
        mode: 'direct',
        reply: `${file.path} (${file.content.split('\n').length} lines):\n\n${file.content.slice(0, 20_000)}${file.content.length > 20_000 ? '\n\n… truncated; ask for a specific section.' : ''}`,
        edits: [],
      };
    } catch (err) {
      return { mode: 'direct', reply: err.message, edits: [] };
    }
  }

  const searchMatch = /\b(?:search|grep)\s+(?:for\s+)?(.+?)(?:\s+in\s+([a-z0-9_./-]+))?\s*$/i.exec(text);
  if (searchMatch) {
    try {
      const matches = searchProject(searchMatch[1].replace(/^["']|["']$/g, ''), searchMatch[2] ?? '.');
      return {
        mode: 'direct',
        reply: matches.length
          ? matches.map((match) => `${match.path}:${match.line}: ${match.text}`).join('\n')
          : 'No matches.',
        edits: [],
      };
    } catch (err) {
      return { mode: 'direct', reply: err.message, edits: [] };
    }
  }

  const checkMatch = /\b(?:check|verify|syntax check)\s+(?:the\s+)?(?:file\s+)?([a-z0-9_./-]+\.(?:js|mjs|cjs|json))\b/i.exec(text);
  if (checkMatch) {
    try {
      const { abs, rel } = safePath(checkMatch[1]);
      if (!existsSync(abs)) return { mode: 'direct', reply: 'File not found.', edits: [] };
      const check = checkFile(abs, rel);
      return { mode: 'direct', reply: `${rel}: ${check.ok ? 'OK' : 'FAILED'} — ${check.detail}`, edits: [] };
    } catch (err) {
      return { mode: 'direct', reply: err.message, edits: [] };
    }
  }

  if (/\b(?:doctor|diagnose|site health|check the site)\b/i.test(lower)) {
    const diagnosis = await runDiagnostics({ cache, admin, publicDir });
    return {
      mode: 'direct',
      reply: `${diagnosis.summary.total} checks: ${diagnosis.summary.ok} ok, ${diagnosis.summary.warn} warning(s), ${diagnosis.summary.fail} failure(s).\n${diagnosis.checks
        .filter((check) => check.status !== 'ok')
        .map((check) => `• ${check.label} — ${check.detail}`)
        .join('\n') || 'Everything is healthy.'}`,
      edits: [],
    };
  }

  return null;
}

export async function codeChat({
  message,
  history = [],
  cache = null,
  admin = {},
  publicDir = join(APP_ROOT, 'public'),
} = {}) {
  const direct = await directCodeRequest(message, { cache, admin, publicDir });
  if (direct) return direct;

  const config = aiConfig();
  if (!config) {
    return {
      mode: 'unconfigured',
      reply: 'No AI model is configured. Open Admin → AI settings and add a key, or run a free local model with Ollama, then come back.',
      edits: [],
    };
  }

  const safeHistory = (Array.isArray(history) ? history : [])
    .filter((entry) => (entry?.role === 'user' || entry?.role === 'assistant') && entry.content)
    .slice(-10)
    .map((entry) => ({ role: entry.role, content: String(entry.content).slice(0, 6_000) }));

  const system = [
    'You are Injoy Code Agent, a private coding assistant for this repository.',
    'You have working tools: list_files, read_file, search_files, propose_edit, run_check, site_doctor and read_logs.',
    'You CAN list and read text project files. You cannot write directly; propose_edit creates a pending diff for the admin to Apply.',
    'Project layout: server/index.js is the HTTP server; server/lib holds catalogue, resolver, subtitles, admin, doctor and AI modules; public/js and public/css are the browser app; deploy/ holds bootstrap and cloud-init; data/ is private runtime state and must never be read or edited.',
    'Rules:',
    '- When asked to list, read, search, inspect, explain, fix, check or edit code, you MUST call the matching tool. Never reply that you cannot access files.',
    '- Example: for “list files in server/lib”, call list_files with {"path":"server/lib"}. For “read public/js/app.js”, call read_file with {"path":"public/js/app.js"}.',
    '- Read the relevant files before proposing a change. Keep edits minimal and match the surrounding style.',
    '- Never read or edit .env, data/, .git or node_modules.',
    '- Never invent file paths. Use list_files/read_file/search_files.',
    '- Propose complete file content, not a partial patch. One purpose per edit; explain what changed and why.',
    '- Run node --check for JS and JSON.parse for JSON after proposing, or at least call run_check when useful.',
    '- Never claim an edit is applied. Say it is waiting for Apply.',
    '- Server-side edits need a restart; static edits need a hard refresh. State that when relevant.',
    '- Do not change secrets, admin auth, or the deploy security model unless explicitly asked.',
    '- Be concise; the admin is technical.',
    `Admin password length: ${admin.length ?? 0}; never print it.`,
  ].join('\n');

  const messages = [
    { role: 'system', content: system },
    ...safeHistory,
    { role: 'user', content: String(message ?? '').slice(0, 6_000) },
  ];

  const edits = [];
  try {
    for (let round = 0; round < 5; round += 1) {
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
          temperature: 0.1,
        }),
        signal: AbortSignal.timeout(180_000),
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`AI provider ${response.status}: ${text.slice(0, 300)}`);
      let data;
      try { data = JSON.parse(text); } catch { throw new Error('AI provider returned invalid JSON'); }
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
        return { mode: 'ai', reply: String(choice.content ?? '').trim() || 'Done.', edits };
      }

      messages.push({
        role: 'assistant',
        content: explicitCalls.length ? (choice.content ?? null) : null,
        tool_calls: calls,
      });
      for (const call of calls) {
        let args = {};
        try { args = JSON.parse(call.function?.arguments ?? '{}'); } catch { args = {}; }
        let result;
        try {
          result = await runTool(call.function?.name, args, { cache, admin, publicDir });
        } catch (err) {
          result = { ok: false, error: err.message };
        }
        if (result?.edit) edits.push(result.edit);
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
      }
    }
    return { mode: 'ai', reply: 'I stopped after several tool steps. Try a narrower request.', edits };
  } catch (err) {
    return { mode: 'error', reply: `AI provider error: ${err.message}`, edits };
  }
}
