/**
 * Durable custom films.
 *
 * The hosted instance has no disk: anything written to `/data` dies with the
 * container, so a film added through the admin panel would vanish on the next
 * deploy. This module keeps `data/custom-films.json` in the repository instead —
 * the same repository the service is built from — so the entry comes back with
 * the next boot and every visitor sees it.
 *
 * It is opt-in: with no token configured the file stays local and the admin
 * panel says so.
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { dataPath } from './paths.js';

const TOKEN = process.env.GITHUB_TOKEN ?? '';
const REPO = process.env.GITHUB_REPO ?? '';
const BRANCH = process.env.GITHUB_BRANCH ?? 'main';
const FILE_PATH = 'data/custom-films.json';

const state = {
  lastPush: null,
  lastPull: null,
  error: null,
};

export const persistEnabled = () => Boolean(TOKEN && REPO);

export function persistStatus() {
  return {
    enabled: persistEnabled(),
    repo: REPO || null,
    branch: BRANCH,
    file: FILE_PATH,
    lastPush: state.lastPush,
    lastPull: state.lastPull,
    error: state.error,
  };
}

const headers = () => ({
  authorization: `Bearer ${TOKEN}`,
  accept: 'application/vnd.github+json',
  'user-agent': 'injoy',
});

/** The file's current blob id, needed by the contents API to replace it. */
async function remoteSha() {
  const res = await fetch(`https://api.github.com/repos/${REPO}/contents/${FILE_PATH}?ref=${BRANCH}`, {
    headers: headers(),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`github ${res.status}`);
  const body = await res.json();
  return body?.sha ?? null;
}

/**
 * Copy the repository's copy into the local data directory, when the repository
 * has one. Called once at boot, before the catalogue is built.
 */
export async function pullCustomFilms() {
  // Reading the raw file needs no credentials: a public repository answers
  // anyone. Only writing does, so the pull runs on every boot.
  if (!REPO) return { skipped: true, reason: 'no GITHUB_REPO' };
  try {
    const res = await fetch(
      `https://raw.githubusercontent.com/${REPO}/${BRANCH}/${FILE_PATH}?t=${Date.now()}`,
      { headers: { 'user-agent': 'injoy' } },
    );
    if (res.status === 404) {
      state.lastPull = new Date().toISOString();
      return { pulled: false, reason: 'no file yet' };
    }
    if (!res.ok) throw new Error(`raw ${res.status}`);
    const text = await res.text();
    if (!text.trim()) return { pulled: false, reason: 'empty file' };
    const file = dataPath('custom-films.json');
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, text, 'utf8');
    state.lastPull = new Date().toISOString();
    state.error = null;
    return { pulled: true, bytes: text.length };
  } catch (err) {
    state.error = String(err.message ?? err).slice(0, 160);
    return { pulled: false, error: state.error };
  }
}

/** Commit the local file to the repository. Safe to call on every change. */
export async function pushCustomFilms(commitMessage = 'injoy: catalogue change') {
  if (!persistEnabled()) return { pushed: false, reason: 'no token configured' };
  const file = dataPath('custom-films.json');
  if (!existsSync(file)) return { pushed: false, reason: 'nothing to push' };

  try {
    const text = await readFile(file, 'utf8');
    const sha = await remoteSha();
    const res = await fetch(`https://api.github.com/repos/${REPO}/contents/${FILE_PATH}`, {
      method: 'PUT',
      headers: { ...headers(), 'content-type': 'application/json' },
      body: JSON.stringify({
        message: commitMessage,
        content: Buffer.from(text, 'utf8').toString('base64'),
        branch: BRANCH,
        ...(sha ? { sha } : {}),
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`github ${res.status}: ${body.slice(0, 120)}`);
    }
    state.lastPush = new Date().toISOString();
    state.error = null;
    return { pushed: true };
  } catch (err) {
    state.error = String(err.message ?? err).slice(0, 160);
    return { pushed: false, error: state.error };
  }
}
