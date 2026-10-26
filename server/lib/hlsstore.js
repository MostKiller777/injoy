import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { dataPath } from './paths.js';
import { FMP4_MIMES, tsMimes } from './tscodec.js';

/**
 * On-disk HLS store.
 *
 * An HLS download is a directory of segments, one file each, in playlist order.
 * That layout is what makes a download resumable: a segment already on disk is
 * skipped, so a job that died at segment 56 of 271 — or a server that restarted
 * mid-fetch — continues from where it stopped instead of starting over.
 *
 * Playback reuses the live HLS feeder unchanged: the client asks for index N and
 * this store hands back file N. fMP4 playlists keep their init segment at index
 * 0, exactly like the live proxy does.
 *
 * Layout:
 *   <data>/media/hls/<id>/manifest.json
 *   <data>/media/hls/<id>/seg-00000.ts
 *   <data>/media/hls/<id>/seg-00001.ts
 *   <data>/media/hls/<id>/init.mp4        (fMP4 playlists only)
 */

const HLS_ROOT = () => dataPath('media', 'hls');

const keyFor = (id) => String(id ?? '').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120);

export const hlsDir = (id) => join(HLS_ROOT(), keyFor(id));
export const hlsManifestPath = (id) => join(hlsDir(id), 'manifest.json');

/** Media segment file. `ext` is `.ts` for transport streams, `.m4s` for fMP4. */
export function hlsSegmentFile(id, index, ext = '.ts') {
  return join(hlsDir(id), `seg-${String(Number(index)).padStart(5, '0')}${ext}`);
}

export const hlsInitFile = (id) => join(hlsDir(id), 'init.mp4');

export async function prepareHlsDir(id) {
  await mkdir(hlsDir(id), { recursive: true });
}

export async function writeHlsManifest(id, manifest) {
  await writeFile(hlsManifestPath(id), JSON.stringify(manifest, null, 2), 'utf8');
}

export async function readHlsManifest(id) {
  try {
    return JSON.parse(await readFile(hlsManifestPath(id), 'utf8'));
  } catch {
    return null;
  }
}

/** The client-facing session: the same shape the live proxy returns. */
export function hlsSessionFrom(manifest) {
  const fmp4 = manifest.container === 'hls-fmp4';
  // A finished download carries its probed codec list. A copy still in progress
  // may not, and a bare `video/mp2t` is exactly what MSE refuses — so fall back
  // to the same candidate list a live session would send.
  const mimes = Array.isArray(manifest.mimes) && manifest.mimes.length
    ? manifest.mimes
    : fmp4
      ? FMP4_MIMES
      : tsMimes(null);
  return {
    base: `/api/local-hls/${encodeURIComponent(manifest.id)}`,
    container: manifest.container ?? (fmp4 ? 'hls-fmp4' : 'hls'),
    quality: manifest.quality ?? 'source',
    duration: manifest.duration ?? null,
    segments: manifest.segments,
    durations: manifest.durations ?? [],
    segmentDuration: manifest.segmentDuration ?? 4,
    mime: manifest.mime ?? mimes[0],
    mimes,
    hasMap: fmp4,
    startPts: manifest.startPts ?? 0,
    local: true,
  };
}

export async function hlsSession(id) {
  const manifest = await readHlsManifest(id);
  return manifest ? hlsSessionFrom(manifest) : null;
}

/** How many media segments are already on disk. */
export async function countHlsSegments(id, ext = '.ts') {
  const names = await readdir(hlsDir(id)).catch(() => []);
  const wanted = ext === '.m4s' ? '.m4s' : '.ts';
  return names.filter((name) => name.startsWith('seg-') && name.endsWith(wanted)).length;
}

/**
 * The first index whose file is missing, so a resume never leaves a hole in the
 * middle of the timeline — a gap there is a stall at that timestamp.
 */
export async function firstMissingHlsSegment(id, ext = '.ts', total = Infinity) {
  for (let index = 0; index < total; index += 1) {
    const info = await stat(hlsSegmentFile(id, index, ext)).catch(() => null);
    if (!info || info.size === 0) return index;
  }
  return Math.min(total, Number.isFinite(total) ? total : 0);
}

export async function hlsBytes(id) {
  const names = await readdir(hlsDir(id)).catch(() => []);
  let total = 0;
  for (const name of names) {
    if (!name.endsWith('.ts') && !name.endsWith('.m4s') && !name.endsWith('.mp4')) continue;
    const info = await stat(join(hlsDir(id), name)).catch(() => null);
    if (info?.isFile()) total += info.size;
  }
  return total;
}

export async function removeHls(id) {
  await rm(hlsDir(id), { recursive: true, force: true }).catch(() => {});
}

/**
 * Read one stored segment by client index. With an init segment the numbering is
 * shifted by one — index 0 is the init, 1..n are the media segments.
 */
export async function readLocalHlsSegment(id, index) {
  const manifest = await readHlsManifest(id);
  if (!manifest) return null;
  const fmp4 = manifest.container === 'hls-fmp4';
  const number = Number(index);
  if (!Number.isInteger(number) || number < 0) return null;

  if (fmp4 && number === 0) {
    const bytes = await readFile(hlsInitFile(id)).catch(() => null);
    return bytes ? { bytes, contentType: 'video/mp4' } : null;
  }

  const mediaIndex = fmp4 ? number - 1 : number;
  if (mediaIndex >= manifest.segments) return null;
  const bytes = await readFile(hlsSegmentFile(id, mediaIndex, manifest.ext ?? '.ts')).catch(() => null);
  return bytes ? { bytes, contentType: fmp4 ? 'video/mp4' : 'video/mp2t' } : null;
}
