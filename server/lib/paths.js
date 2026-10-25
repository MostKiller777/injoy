import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Repository root — the directory that holds `server/`, `public/` and `data/`. */
export const APP_ROOT = resolve(HERE, '../..');

/**
 * Where mutable state lives.
 *
 * Defaults to `data/` beside the server. `DATA_DIR` overrides it so a container
 * can mount a volume there: the image stays read-only and the library and
 * downloaded files survive a redeploy.
 *
 * Resolved per call, not at import time, because `.env` is read after the
 * modules load.
 */
export function dataRoot() {
  const override = process.env.DATA_DIR?.trim();
  return override ? resolve(override) : join(APP_ROOT, 'data');
}

export function dataPath(...parts) {
  return join(dataRoot(), ...parts);
}
