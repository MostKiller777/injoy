import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { dataPath } from './paths.js';

/**
 * On-disk DASH store.
 *
 * A downloaded title keeps its two tracks as fMP4 fragments, exactly as the
 * provider served them: one init segment per track, then one file per five
 * seconds of media. That is what a browser's MSE wants, so playback needs no
 * muxer — the player pulls the same segment indices it would have pulled from
 * the network, only now they come off this disk.
 *
 * Layout:
 *   <data>/media/dash/<id>/manifest.json
 *   <data>/media/dash/<id>/video/init.mp4
 *   <data>/media/dash/<id>/video/00001.m4s
 *   <data>/media/dash/<id>/audio/...
 */

const DASH_ROOT = () => dataPath('media', 'dash');

const keyFor = (id) => String(id ?? '').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120);

export const dashDir = (id) => join(DASH_ROOT(), keyFor(id));
export const dashManifestPath = (id) => join(dashDir(id), 'manifest.json');
export const dashTrackDir = (id, track) => join(dashDir(id), track);

export function dashSegmentFile(id, track, index) {
  const name = Number(index) === 0 ? 'init.mp4' : `${String(index).padStart(5, '0')}.m4s`;
  return join(dashTrackDir(id, track), name);
}

export async function prepareDashDir(id) {
  await mkdir(dashTrackDir(id, 'video'), { recursive: true });
  await mkdir(dashTrackDir(id, 'audio'), { recursive: true });
}

export async function writeDashManifest(id, manifest) {
  await writeFile(dashManifestPath(id), JSON.stringify(manifest, null, 2), 'utf8');
}

export async function readDashManifest(id) {
  try {
    return JSON.parse(await readFile(dashManifestPath(id), 'utf8'));
  } catch {
    return null;
  }
}

/** The client-facing session: everything the MSE feeder needs, no URLs. */
export function dashSessionFrom(manifest) {
  return {
    base: `/api/local-dash/${encodeURIComponent(manifest.id)}/seg`,
    duration: manifest.duration,
    segmentDuration: manifest.segmentDuration,
    segments: manifest.segments,
    startNumber: manifest.startNumber ?? 1,
    video: {
      mime: manifest.video.mime,
      codecs: manifest.video.codecs,
      width: manifest.video.width ?? 0,
      height: manifest.video.height ?? 0,
      bandwidth: manifest.video.bandwidth ?? 0,
    },
    audio: { mime: manifest.audio.mime, codecs: manifest.audio.codecs },
  };
}

export async function dashSession(id) {
  const manifest = await readDashManifest(id);
  return manifest ? dashSessionFrom(manifest) : null;
}

/** Total bytes on disk, used by the media index and the health route. */
export async function dashBytes(id) {
  let total = 0;
  for (const track of ['video', 'audio']) {
    const dir = dashTrackDir(id, track);
    const names = await readdir(dir).catch(() => []);
    for (const name of names) {
      const info = await stat(join(dir, name)).catch(() => null);
      if (info?.isFile()) total += info.size;
    }
  }
  return total;
}

export async function removeDash(id) {
  await rm(dashDir(id), { recursive: true, force: true }).catch(() => {});
}

/** Read one stored segment (0 = init). Returns a Buffer or null. */
export async function readDashSegment(id, track, index) {
  if (track !== 'video' && track !== 'audio') return null;
  const number = Number(index);
  if (!Number.isInteger(number) || number < 0) return null;
  try {
    return await readFile(dashSegmentFile(id, track, number));
  } catch {
    return null;
  }
}
