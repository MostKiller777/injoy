import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const MAX_LIST = 600;
const MAX_PROGRESS = 600;

/**
 * Watchlist + resume points in one small JSON file.
 * Writes are debounced and atomic (tmp + rename) so a crash never truncates the db.
 */
export class Store {
  constructor(file) {
    this.file = resolve(file);
    this.data = { watchlist: [], progress: {}, updatedAt: 0 };
    this.timer = null;
    this.chain = Promise.resolve();
    this.dirty = false;
  }

  async load() {
    try {
      const raw = await readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed?.watchlist)) this.data.watchlist = parsed.watchlist.slice(0, MAX_LIST);
      if (parsed?.progress && typeof parsed.progress === 'object') {
        this.data.progress = parsed.progress;
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.warn(`[store] could not read ${this.file}: ${err.message} — starting empty`);
      }
    }
    return this;
  }

  list() {
    return this.data.watchlist;
  }

  has(id) {
    return this.data.watchlist.some((item) => item.id === id);
  }

  add(item) {
    if (!item?.id) throw new Error('item.id required');
    const existing = this.data.watchlist.findIndex((entry) => entry.id === item.id);
    if (existing !== -1) this.data.watchlist.splice(existing, 1);
    this.data.watchlist.unshift({ ...item, addedAt: Date.now() });
    if (this.data.watchlist.length > MAX_LIST) this.data.watchlist.length = MAX_LIST;
    this.touch();
    return this.data.watchlist[0];
  }

  remove(id) {
    const before = this.data.watchlist.length;
    this.data.watchlist = this.data.watchlist.filter((entry) => entry.id !== id);
    if (this.data.watchlist.length !== before) this.touch();
    return this.data.watchlist.length !== before;
  }

  progressFor(id) {
    return this.data.progress[id] ?? null;
  }

  allProgress() {
    return this.data.progress;
  }

  setProgress(id, seconds, duration) {
    if (!id || !Number.isFinite(seconds)) return null;
    const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : null;
    const entry = {
      t: Math.max(0, Math.round(seconds)),
      d: safeDuration ? Math.round(safeDuration) : null,
      updatedAt: Date.now(),
    };
    this.data.progress[id] = entry;

    const keys = Object.keys(this.data.progress);
    if (keys.length > MAX_PROGRESS) {
      keys
        .sort((a, b) => (this.data.progress[a].updatedAt ?? 0) - (this.data.progress[b].updatedAt ?? 0))
        .slice(0, keys.length - MAX_PROGRESS)
        .forEach((key) => delete this.data.progress[key]);
    }

    this.touch();
    return entry;
  }

  touch() {
    this.data.updatedAt = Date.now();
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush().catch((err) => console.warn(`[store] flush failed: ${err.message}`));
    }, 200);
    this.timer.unref?.();
  }

  flush() {
    if (!this.dirty) return this.chain;
    this.dirty = false;
    const snapshot = JSON.stringify(this.data, null, 2);
    this.chain = this.chain.then(async () => {
      await mkdir(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      await writeFile(tmp, snapshot, 'utf8');
      await rename(tmp, this.file);
    });
    return this.chain;
  }
}
