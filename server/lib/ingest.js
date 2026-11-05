/**
 * Ingest pipeline.
 *
 * One uploaded file in, a quality ladder out: probe, validate, encode every
 * rendition up to the source height, mux the audio, carry the subtitles, and
 * refuse to publish anything that fails the QC gate.
 *
 * Nothing here assumes a tool is installed. Without ffmpeg the job still gets
 * probed (ffprobe is a separate binary), planned and QC'd against the sidecars
 * that were uploaded with it — the run is marked `tooling-missing` instead of
 * pretending it encoded something.
 */

import { spawn } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile, copyFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { basename, dirname, extname, join, normalize, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { dataPath } from './paths.js';

const ROOT = () => dataPath('ingest');
const JOBS_FILE = () => join(ROOT(), 'jobs.json');

const MAX_UPLOAD_BYTES = Number(process.env.INGEST_MAX_GB ?? 12) * 1024 ** 3;
const SEGMENT_SECONDS = 6;

// Heights the ladder can target. A source only ever gets a rung at or below its
// own height: upscaling a 480p file to 4K produces a bigger file, not a better
// picture.
const LADDER = [240, 360, 480, 720, 1080, 1440, 2160];

const AUDIO_CODECS = /^(aac|mp3|ac3|eac3|opus|vorbis|flac|pcm_s16le)$/i;
const VIDEO_CODECS = /^(h264|hevc|vp9|av1|mpeg4)$/i;
const CONTAINERS = /\.(mp4|mkv|mov|avi|webm|m4v|ts|m2ts|flv|wmv)$/i;

const jobs = new Map();
const listeners = new Set();
let loaded = false;

/* ------------------------------ tooling --------------------------------- */

function whichSync(binary) {
  const dirs = (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':');
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, `${binary}${ext}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

export function tooling() {
  const ffmpeg = process.env.FFMPEG_PATH?.trim() || whichSync('ffmpeg');
  const ffprobe = process.env.FFPROBE_PATH?.trim() || whichSync('ffprobe');
  return {
    ffmpeg: ffmpeg ?? null,
    ffprobe: ffprobe ?? null,
    canEncode: Boolean(ffmpeg && ffprobe),
  };
}

/* ------------------------------- helpers -------------------------------- */

const emit = () => {
  const snapshot = listJobs();
  for (const listener of listeners) {
    try {
      listener(snapshot);
    } catch {
      listeners.delete(listener);
    }
  }
};

export function subscribe(listener) {
  listeners.add(listener);
  listener(listJobs());
  return () => listeners.delete(listener);
}

const safeName = (name) => basename(String(name ?? 'source')).replace(/[^\w.\- ]+/g, '_').slice(0, 120);

function jobDir(id) {
  return join(ROOT(), id);
}

function publicJob(job) {
  return {
    id: job.id,
    title: job.title,
    state: job.state,
    progress: job.progress,
    message: job.message,
    source: job.source,
    ladder: job.ladder,
    audio: job.audio,
    subtitles: job.subtitles,
    qc: job.qc,
    tooling: job.tooling,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    error: job.error ?? null,
  };
}

export function listJobs() {
  return [...jobs.values()]
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(publicJob);
}

export function getJob(id) {
  const job = jobs.get(String(id));
  return job ? publicJob(job) : null;
}

async function save() {
  try {
    await mkdir(ROOT(), { recursive: true });
    const payload = [...jobs.values()].slice(-200);
    const tmp = `${JOBS_FILE()}.tmp`;
    await writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8');
    await rename(tmp, JOBS_FILE());
  } catch {
    // a failed save must not kill a running encode
  }
}

async function load() {
  if (loaded) return;
  loaded = true;
  try {
    const parsed = JSON.parse(await readFile(JOBS_FILE(), 'utf8'));
    for (const job of parsed) {
      // A job that was mid-flight when the process died cannot be resumed.
      if (['probing', 'planning', 'encoding', 'packaging'].includes(job.state)) {
        job.state = 'failed';
        job.error = 'interrupted by a restart';
      }
      jobs.set(job.id, job);
    }
  } catch {
    // first run
  }
}

const touch = (job, patch) => {
  Object.assign(job, patch, { updatedAt: Date.now() });
  emit();
};

/* -------------------------------- probe --------------------------------- */

function run(binary, args, { onLine = null, signal = null } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    const feed = (chunk, sink) => {
      const text = chunk.toString();
      if (sink === 'out') stdout += text;
      else stderr += text;
      if (onLine) {
        for (const line of text.split(/\r?\n/)) if (line.trim()) onLine(line.trim(), sink);
      }
      if (stdout.length + stderr.length > 8_000_000) {
        stdout = stdout.slice(-2_000_000);
        stderr = stderr.slice(-2_000_000);
      }
    };
    child.stdout.on('data', (chunk) => feed(chunk, 'out'));
    child.stderr.on('data', (chunk) => feed(chunk, 'err'));
    child.on('error', reject);
    child.on('close', (code) => {
      if (signal?.aborted) return reject(Object.assign(new Error('cancelled'), { cancelled: true }));
      if (code === 0) return resolve({ stdout, stderr });
      reject(Object.assign(new Error(`${basename(binary)} exited ${code}: ${stderr.split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 240)}`), { code }));
    });
    signal?.addEventListener('abort', () => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }, { once: true });
  });
}

/** ffprobe the upload: duration, streams, chapters, and what can be kept. */
async function probe(job) {
  const { ffprobe } = tooling();
  if (!ffprobe) return null;
  const { stdout } = await run(ffprobe, [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    job.sourcePath,
  ]);
  return JSON.parse(stdout || '{}');
}

/* ------------------------------ validation ------------------------------ */

function validate(sourcePath, meta) {
  const problems = [];
  const warnings = [];
  const ext = extname(sourcePath).toLowerCase();

  if (!CONTAINERS.test(ext)) problems.push(`container ${ext || '(none)'} is not a video container`);
  if (!meta) {
    warnings.push('ffprobe is not installed — the file could not be inspected');
    return { ok: problems.length === 0, problems, warnings, video: null, audio: [], subtitles: [] };
  }

  const streams = Array.isArray(meta.streams) ? meta.streams : [];
  const video = streams.filter((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
  const audio = streams.filter((s) => s.codec_type === 'audio');
  const subtitles = streams.filter((s) => s.codec_type === 'subtitle');

  if (!video.length) problems.push('no video stream');
  if (!audio.length) warnings.push('no audio stream — the result will be silent');
  if (video.length > 1) warnings.push(`${video.length} video streams; only the first is used`);

  for (const stream of video) {
    if (!VIDEO_CODECS.test(stream.codec_name ?? '')) problems.push(`video codec ${stream.codec_name} cannot be repackaged`);
    if (!Number(stream.height)) problems.push('video height is unreadable');
  }
  for (const stream of audio) {
    if (!AUDIO_CODECS.test(stream.codec_name ?? '')) warnings.push(`audio codec ${stream.codec_name} will be re-encoded`);
  }

  const duration = Number(meta.format?.duration ?? video[0]?.duration ?? 0);
  if (!Number.isFinite(duration) || duration <= 0) problems.push('duration is unreadable');
  if (duration > 6 * 3600) warnings.push('longer than six hours; the ladder will take a long time');

  return {
    ok: problems.length === 0,
    problems,
    warnings,
    duration,
    video: video[0] ?? null,
    audio: audio.map((stream, index) => ({
      index,
      stream: stream.index,
      codec: stream.codec_name,
      channels: stream.channels ?? null,
      language: stream.tags?.language ?? null,
      title: stream.tags?.title ?? null,
      default: Boolean(stream.disposition?.default),
    })),
    subtitles: subtitles.map((stream) => ({
      stream: stream.index,
      codec: stream.codec_name,
      language: stream.tags?.language ?? null,
      title: stream.tags?.title ?? null,
    })),
  };
}

/** The rungs this source is allowed to have. */
function buildLadder(height, width) {
  const source = Number(height) || 0;
  const usable = LADDER.filter((target) => target <= source);
  if (!usable.length) usable.push(source || 360);
  const capped = [...new Set(usable)].sort((a, b) => a - b);
  return capped.map((target) => {
    const scale = source ? target / source : 1;
    return {
      height: target,
      width: Math.max(2, Math.round(((Number(width) || 1920) * scale) / 2) * 2),
      bitrate: Math.round(bitrateFor(target)),
      state: 'pending',
      segments: 0,
    };
  });
}

/** H.264 bitrate per rung, tuned for a 6 s segment HLS ladder. */
function bitrateFor(height) {
  if (height >= 2160) return 14_000_000;
  if (height >= 1440) return 9_000_000;
  if (height >= 1080) return 5_000_000;
  if (height >= 720) return 2_800_000;
  if (height >= 480) return 1_400_000;
  if (height >= 360) return 800_000;
  return 420_000;
}

/* -------------------------------- encode -------------------------------- */

async function encodeRung(job, rung, signal) {
  const { ffmpeg } = tooling();
  const out = join(jobDir(job.id), 'out', `v${rung.height}`);
  await mkdir(out, { recursive: true });

  const args = [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', job.sourcePath,
    '-map', '0:v:0',
    // The first audio track rides along in the muxed playlist; extra languages
    // are emitted as separate groups below.
    ...(job.audio.length ? ['-map', `0:a:${job.audio[0].index}`] : []),
    '-vf', `scale=-2:${rung.height}:flags=lanczos`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'main',
    '-crf', '20', '-maxrate', `${Math.round(rung.bitrate / 1000)}k`, '-bufsize', `${Math.round((rung.bitrate * 1.5) / 1000)}k`,
    '-g', String(SEGMENT_SECONDS * 4), '-keyint_min', String(SEGMENT_SECONDS * 4), '-sc_threshold', '0',
    ...(job.audio.length ? ['-c:a', 'aac', '-b:a', '160k', '-ac', '2'] : []),
    '-f', 'hls',
    '-hls_time', String(SEGMENT_SECONDS),
    '-hls_playlist_type', 'vod',
    '-hls_flags', 'independent_segments',
    '-hls_segment_filename', join(out, 'seg-%05d.ts'),
    join(out, 'index.m3u8'),
  ];

  const duration = job.source?.duration ?? 0;
  let lastPercent = -1;
  await run(ffmpeg, args, {
    signal,
    onLine: (line) => {
      const match = /time=(\d+):(\d+):(\d+\.\d+)/.exec(line);
      if (!match || !duration) return;
      const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
      const overall = Math.min(99, Math.round((seconds / duration) * 100));
      if (overall !== lastPercent) {
        lastPercent = overall;
        touch(job, { progress: overall, message: `encoding ${rung.height}p` });
      }
    },
  });

  const files = await readdir(out).catch(() => []);
  rung.segments = files.filter((name) => name.endsWith('.ts')).length;
  rung.state = rung.segments ? 'done' : 'empty';
  // The primary track is muxed into every rung, so it is finished as soon as a
  // rung is.
  if (job.audio[0] && rung.state === 'done') job.audio[0].state = 'done';
  touch(job, { ladder: job.ladder, audio: job.audio });
}

/** Extra audio languages, one HLS group each. */
async function encodeAudioGroup(job, track, signal) {
  const { ffmpeg } = tooling();
  const out = join(jobDir(job.id), 'out', `a${track.index}`);
  await mkdir(out, { recursive: true });
  await run(ffmpeg, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', job.sourcePath,
    '-map', `0:a:${track.index}`,
    '-c:a', 'aac', '-b:a', '160k', '-ac', '2',
    '-f', 'hls',
    '-hls_time', String(SEGMENT_SECONDS),
    '-hls_playlist_type', 'vod',
    '-hls_segment_filename', join(out, 'seg-%05d.aac'),
    join(out, 'index.m3u8'),
  ], { signal });
  track.state = 'done';
  touch(job, { audio: job.audio });
}

/* -------------------------------- package ------------------------------- */

/** Sum of EXTINF tags: what the playlist will actually play. */
async function playlistDuration(file) {
  const text = await readFile(file, 'utf8');
  let total = 0;
  for (const match of text.matchAll(/#EXTINF:([\d.]+)/g)) total += Number(match[1]) || 0;
  return total;
}

const mimeFor = (name) => {  if (name.endsWith('.m3u8')) return 'application/vnd.apple.mpegurl';
  if (name.endsWith('.ts')) return 'video/mp2t';
  if (name.endsWith('.vtt')) return 'text/vtt';
  if (name.endsWith('.aac')) return 'audio/aac';
  if (name.endsWith('.jpg')) return 'image/jpeg';
  return 'application/octet-stream';
};

/** Master playlist over every finished rung, with audio groups and subtitles. */
async function writeMaster(job) {
  const out = join(jobDir(job.id), 'out');
  const rungs = job.ladder.filter((rung) => rung.state === 'done');
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-INDEPENDENT-SEGMENTS'];

  for (const track of job.audio.filter((entry) => entry.state === 'done' && entry.index > 0)) {
    const label = track.language ?? track.title ?? `audio ${track.index + 1}`;
    lines.push(`#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="${label}",DEFAULT=NO,AUTOSELECT=YES,URI="a${track.index}/index.m3u8"`);
  }
  const primary = job.audio[0];
  if (primary) {
    const label = primary.language ?? primary.title ?? 'main';
    lines.push(`#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="${label}",DEFAULT=YES,AUTOSELECT=YES,URI="v${rungs.at(-1)?.height ?? 360}/index.m3u8"`);
  }

  for (const rung of rungs) {
    const bandwidth = rung.bitrate + (primary ? 160_000 : 0);
    lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},RESOLUTION=${rung.width}x${rung.height},CODECS="avc1.4d401f,mp4a.40.2"`);
    lines.push(`v${rung.height}/index.m3u8`);
  }

  for (const subtitle of job.subtitles.filter((entry) => entry.state === 'done')) {
    const label = subtitle.language ?? subtitle.title ?? `subtitle ${subtitle.index + 1}`;
    lines.push(`#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="${label}",DEFAULT=NO,AUTOSELECT=YES,URI="${subtitle.file}"`);
  }

  await writeFile(join(out, 'master.m3u8'), `${lines.join('\n')}\n`, 'utf8');
  return rungs.length;
}

/** Sidecar .srt/.vtt files dropped with the source ride along as WebVTT (copy). */
async function collectSubtitles(job, uploads) {
  const out = join(jobDir(job.id), 'out');
  await mkdir(out, { recursive: true });
  const list = [];
  for (const upload of uploads) {
    if (!/\.(srt|vtt)$/i.test(upload.name)) continue;
    const target = join(out, `sub-${list.length}${extname(upload.name).toLowerCase()}`);
    await copyFile(upload.path, target).catch(() => null);
    list.push({
      index: list.length,
      file: basename(target),
      language: upload.language ?? null,
      title: upload.name,
      state: existsSync(target) ? 'done' : 'missing',
    });
  }
  return list;
}

/* --------------------------------- QC ----------------------------------- */

/**
 * The gate. Nothing is published until every rung has segments, the master only
 * points at playlists that exist, and the duration still matches the source.
 */
async function runQc(job) {
  const checks = [];
  const out = join(jobDir(job.id), 'out');
  const duration = Number(job.source?.duration ?? 0);

  checks.push({
    id: 'rungs',
    label: 'At least one rendition encoded',
    ok: job.ladder.some((rung) => rung.state === 'done'),
    detail: `${job.ladder.filter((rung) => rung.state === 'done').length} of ${job.ladder.length} rungs`,
  });

  for (const rung of job.ladder) {
    const dir = join(out, `v${rung.height}`);
    const files = await readdir(dir).catch(() => []);
    const segments = files.filter((name) => name.endsWith('.ts')).length;
    const playlist = files.includes('index.m3u8');
    checks.push({
      id: `rung-${rung.height}`,
      label: `${rung.height}p playlist and segments`,
      ok: playlist && segments > 0,
      detail: `${segments} segments${playlist ? '' : ', no playlist'}`,
    });
  }

  const master = await readFile(join(out, 'master.m3u8'), 'utf8').catch(() => '');
  // Every line that is not a tag is a URI the master points at.
  const refs = master
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => line.replace(/^\.\//, ''));
  const missingRefs = [];
  for (const ref of refs) {
    if (!existsSync(join(out, ref))) missingRefs.push(ref);
  }
  checks.push({
    id: 'master',
    label: 'Master playlist references existing renditions',
    ok: Boolean(master) && refs.length > 0 && !missingRefs.length,
    detail: master ? (missingRefs.length ? `missing ${missingRefs.join(', ')}` : `${refs.length} references`) : 'no master playlist',
  });

  if (duration) {
    // Measure the real playlist: segment count × target time is wrong for a
    // file that ends mid-segment, and a short film would fail on rounding.
    const longest = job.ladder
      .filter((rung) => rung.state === 'done')
      .reduce((best, rung) => (rung.segments > best.segments ? rung : best), { segments: 0, height: null });
    const packed = await playlistDuration(join(out, `v${longest.height}`, 'index.m3u8')).catch(() => 0);
    const drift = packed ? Math.abs(packed - duration) / duration : 1;
    checks.push({
      id: 'duration',
      label: 'Packed duration matches the source',
      ok: drift < 0.12,
      detail: `source ${Math.round(duration)}s, packed≈${packed.toFixed(1)}s (${(drift * 100).toFixed(1)}% drift)`,
    });
  }

  const codecs = job.ladder.some((rung) => rung.state === 'done');
  checks.push({
    id: 'codecs',
    label: 'H.264 + AAC, playable in every browser',
    ok: codecs,
    detail: codecs ? 'libx264 / aac' : 'nothing encoded',
  });

  const failed = checks.filter((check) => !check.ok);
  return {
    passed: failed.length === 0,
    at: new Date().toISOString(),
    checks,
    summary: failed.length ? `${failed.length} check(s) failed` : 'all checks passed',
  };
}

/* -------------------------------- pipeline ------------------------------ */

// Staged uploads wait here between the HTTP request and the job that consumes
// them. Keys are opaque ids so a client never names a path on disk.
const staged = new Map();

export async function stageUpload(readable, { name, length = null }) {
  const entry = await acceptUpload(readable, { name, length });
  const id = randomUUID();
  staged.set(id, { id, ...entry, at: Date.now() });
  // An abandoned upload must not keep a multi-gigabyte file forever.
  setTimeout(() => {
    const stale = staged.get(id);
    if (!stale) return;
    staged.delete(id);
    void rm(stale.path, { force: true }).catch(() => {});
  }, 6 * 3600_000).unref?.();
  return { id, name: entry.name, bytes: entry.bytes };
}

export function stagedUploads() {
  return [...staged.values()].map(({ id, name, bytes }) => ({ id, name, bytes }));
}

export async function createJob({ title, uploads = [] }) {
  await load();
  const resolved = uploads
    .map((upload) => (typeof upload === 'string' ? staged.get(upload) : upload))
    .filter(Boolean);
  if (!resolved.length) throw Object.assign(new Error('no uploaded file'), { status: 400 });

  const id = randomUUID();
  const dir = jobDir(id);
  await mkdir(dir, { recursive: true });

  const primary = resolved.find((upload) => CONTAINERS.test(upload.name)) ?? resolved[0];
  if (!primary) throw Object.assign(new Error('no video file in the upload'), { status: 400 });

  const sourcePath = join(dir, safeName(primary.name));
  await rename(primary.path, sourcePath).catch(async () => {
    await copyFile(primary.path, sourcePath);
    await rm(primary.path, { force: true });
  });
  for (const upload of resolved) staged.delete(upload.id);

  const job = {
    id,
    title: title || basename(primary.name),
    state: 'queued',
    progress: 0,
    message: 'queued',
    sourcePath,
    source: { file: primary.name, bytes: (await stat(sourcePath).catch(() => ({ size: 0 }))).size, duration: null, height: null, width: null },
    ladder: [],
    audio: [],
    subtitles: [],
    qc: null,
    tooling: tooling(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    uploads: resolved.map((upload) => ({ name: upload.name, path: upload.path })),
  };

  jobs.set(id, job);
  emit();
  return publicJob(job);
}

/** Run one job to completion. Failures land on the job, never on the caller. */
export async function runJob(id, { signal = null } = {}) {
  const job = jobs.get(String(id));
  if (!job) return null;

  try {
    touch(job, { state: 'probing', message: 'probing the upload', progress: 2 });
    const meta = await probe(job).catch((err) => {
      job.error = err.message;
      return null;
    });

    touch(job, { state: 'validating', message: 'validating streams', progress: 6 });
    const verdict = validate(job.sourcePath, meta);
    job.validation = verdict;

    if (!verdict.ok) {
      touch(job, { state: 'failed', error: verdict.problems.join('; '), message: 'validation refused the file', progress: 100 });
      await save();
      return publicJob(job);
    }

    const video = verdict.video;
    job.source = {
      ...job.source,
      duration: verdict.duration ?? null,
      height: video?.height ?? null,
      width: video?.width ?? null,
      videoCodec: video?.codec_name ?? null,
      warnings: verdict.warnings,
    };
    job.audio = (verdict.audio ?? []).map((track) => ({ ...track, state: 'pending' }));
    job.subtitles = await collectSubtitles(job, job.uploads);

    touch(job, { state: 'planning', message: 'building the ladder', progress: 10 });
    job.ladder = buildLadder(video?.height, video?.width);
    touch(job, { ladder: job.ladder });

    if (!tooling().canEncode) {
      job.qc = await runQc(job);
      touch(job, {
        state: 'tooling-missing',
        message: 'ffmpeg/ffprobe not installed — validated and planned only',
        progress: 100,
        qc: job.qc,
      });
      await save();
      return publicJob(job);
    }

    touch(job, { state: 'encoding', message: 'encoding', progress: 12 });
    let done = 0;
    for (const rung of job.ladder) {
      if (signal?.aborted) throw Object.assign(new Error('cancelled'), { cancelled: true });
      rung.state = 'encoding';
      touch(job, { ladder: job.ladder });
      await encodeRung(job, rung, signal);
      done += 1;
      touch(job, { progress: 12 + Math.round((done / job.ladder.length) * 76) });
    }

    for (const track of job.audio.slice(1)) {
      if (signal?.aborted) throw Object.assign(new Error('cancelled'), { cancelled: true });
      track.state = 'encoding';
      touch(job, { audio: job.audio });
      await encodeAudioGroup(job, track, signal).catch(() => { track.state = 'failed'; });
    }

    touch(job, { state: 'packaging', message: 'writing the master playlist', progress: 92 });
    await writeMaster(job);

    touch(job, { state: 'qc', message: 'quality gate', progress: 96 });
    job.qc = await runQc(job);

    if (!job.qc.passed) {
      touch(job, { state: 'failed', message: 'QC gate refused the result', error: job.qc.summary, progress: 100, qc: job.qc });
      await save();
      return publicJob(job);
    }

    touch(job, { state: 'ready', message: 'ready to play', progress: 100, qc: job.qc });
    await save();
    return publicJob(job);
  } catch (err) {
    touch(job, {
      state: err.cancelled ? 'cancelled' : 'failed',
      message: err.cancelled ? 'cancelled' : 'failed',
      error: String(err.message ?? err).slice(0, 240),
      progress: 100,
    });
    await save();
    return publicJob(job);
  }
}

export async function cancelJob(id) {
  const job = jobs.get(String(id));
  if (!job) return false;
  job.cancelled = true;
  touch(job, { state: 'cancelled', message: 'cancelled', progress: 100 });
  await save();
  return true;
}

export async function removeJob(id) {
  const job = jobs.get(String(id));
  if (!job) return false;
  jobs.delete(String(id));
  await rm(jobDir(id), { recursive: true, force: true }).catch(() => {});
  await save();
  emit();
  return true;
}

/** Accept an uploaded stream into the job's upload area. */
export async function acceptUpload(readable, { name, length = null }) {
  if (length && length > MAX_UPLOAD_BYTES) {
    throw Object.assign(new Error(`file larger than ${Math.round(MAX_UPLOAD_BYTES / 1024 ** 3)} GB`), { status: 413 });
  }
  await mkdir(join(ROOT(), 'tmp'), { recursive: true });
  const path = join(ROOT(), 'tmp', `${randomUUID()}-${safeName(name)}`);
  await new Promise((resolve, reject) => {
    const sink = createWriteStream(path);
    let written = 0;
    readable.on('data', (chunk) => {
      written += chunk.length;
      if (written > MAX_UPLOAD_BYTES) {
        readable.destroy();
        sink.destroy();
        reject(Object.assign(new Error('upload exceeds the size limit'), { status: 413 }));
      }
    });
    readable.on('error', reject);
    sink.on('error', reject);
    sink.on('close', resolve);
    readable.pipe(sink);
  });
  return { path, name: safeName(name), bytes: (await stat(path)).size };
}

/** Serve one file out of a finished job, with a path guard. */
export async function readJobFile(id, relative) {
  const job = jobs.get(String(id));
  if (!job) return { error: 'unknown job', status: 404 };
  const root = join(jobDir(job.id), 'out');
  const target = normalize(join(root, relative));
  if (!target.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)) return { error: 'forbidden', status: 403 };
  const info = await stat(target).catch(() => null);
  if (!info?.isFile()) return { error: 'not found', status: 404 };
  return { stream: createReadStream(target), size: info.size, type: mimeFor(target), path: target };
}

export function ingestRoot() {
  return ROOT();
}

/** Playback descriptor for the player: the job's master playlist, our file route. */
export function ingestPlayback(id) {
  const job = jobs.get(String(id));
  if (!job || job.state !== 'ready') return null;
  return {
    provider: 'ingest',
    label: 'Ingested',
    kind: 'direct',
    container: 'hls',
    quality: job.ladder.filter((rung) => rung.state === 'done').at(-1)?.height ? `${job.ladder.filter((rung) => rung.state === 'done').at(-1).height}p` : 'auto',
    duration: job.source?.duration ?? null,
    url: `/api/ingest/hls/${job.id}/master.m3u8`,
  };
}
