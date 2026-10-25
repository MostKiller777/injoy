import { open } from 'node:fs/promises';

/**
 * Duration probe for MPEG-TS files.
 *
 * A raw transport stream carries no global header and no duration field — the
 * only place the timeline exists is in the 33-bit PTS stamped on each PES
 * packet. So the duration is the span between the first and last PTS in the
 * file: read the head, read the tail, subtract.
 *
 * Only PES headers are parsed (no payload, no decoding), which keeps this to a
 * few megabytes of reads regardless of file size.
 */

const PACKET = 188;
const SYNC = 0x47;
const HEAD_BYTES = 2 * 1024 * 1024;
const TAIL_BYTES = 2 * 1024 * 1024;

/** Find a byte offset where three consecutive TS packets line up. */
function findSync(buffer, limit = Math.min(buffer.length - PACKET * 3, 64 * 1024)) {
  for (let offset = 0; offset < limit; offset += 1) {
    if (buffer[offset] !== SYNC) continue;
    if (buffer[offset + PACKET] !== SYNC) continue;
    if (buffer[offset + PACKET * 2] !== SYNC) continue;
    return offset;
  }
  return -1;
}

function readPts(buffer, at) {
  // 33 bits split across five bytes with marker bits at 0x01 positions.
  const a = buffer[at];
  const b = buffer[at + 1];
  const c = buffer[at + 2];
  const d = buffer[at + 3];
  const e = buffer[at + 4];
  if ((a & 0x01) !== 1 || (c & 0x01) !== 1 || (e & 0x01) !== 1) return null;
  return (
    ((a >> 1) & 0x07) * 2 ** 30
    + b * 2 ** 22
    + ((c >> 1) & 0x7f) * 2 ** 15
    + d * 2 ** 7
    + ((e >> 1) & 0x7f)
  );
}

/**
 * Walk the packets in `buffer` and report the lowest and highest PTS found.
 * `first` short-circuits at the first timestamp — enough for the file head.
 */
function scanPts(buffer, { first = false } = {}) {
  const start = findSync(buffer);
  if (start === -1) return null;

  let min = null;
  let max = null;
  const end = buffer.length - PACKET;

  for (let pos = start; pos <= end; pos += PACKET) {
    if (buffer[pos] !== SYNC) {
      // A corrupt or padded run: re-sync rather than scanning garbage.
      const next = findSync(buffer.subarray(pos), PACKET * 4);
      if (next === -1) break;
      pos += next - PACKET;
      continue;
    }

    const pusi = (buffer[pos + 1] & 0x40) !== 0;
    if (!pusi) continue;

    const adaptation = (buffer[pos + 3] >> 4) & 0x03;
    let payload = pos + 4;
    if (adaptation === 2 || adaptation === 3) payload += 1 + buffer[pos + 4];
    if (payload + 13 >= pos + PACKET) continue;

    // PES start code prefix.
    if (buffer[payload] !== 0 || buffer[payload + 1] !== 0 || buffer[payload + 2] !== 1) continue;
    // PTS_DTS_flags in the optional PES header.
    if ((buffer[payload + 7] & 0x80) === 0) continue;

    const pts = readPts(buffer, payload + 9);
    if (pts === null) continue;

    if (min === null || pts < min) min = pts;
    if (max === null || pts > max) max = pts;
    if (first) return { min, max };
  }

  if (min === null) return null;
  return { min, max };
}

/**
 * Duration in seconds, or null when the file is not a parseable transport
 * stream. Values are clamped to a sane range so a corrupt tail cannot report a
 * 40-hour film.
 */
export async function probeTsDuration(file) {
  let handle;
  try {
    handle = await open(file, 'r');
    const { size } = await handle.stat();
    if (size < PACKET * 8) return null;

    const headLength = Math.min(HEAD_BYTES, size);
    const head = Buffer.alloc(headLength);
    await handle.read(head, 0, headLength, 0);
    const headPts = scanPts(head, { first: true });
    if (!headPts) return null;

    const tailLength = Math.min(TAIL_BYTES, size);
    const tail = Buffer.alloc(tailLength);
    await handle.read(tail, 0, tailLength, size - tailLength);
    const tailPts = scanPts(tail);
    if (!tailPts) return null;

    const startPts = Math.min(headPts.min, tailPts.min);
    const endPts = Math.max(headPts.max, tailPts.max);
    if (endPts <= startPts) return null;

    const seconds = (endPts - startPts) / 90_000;
    if (!Number.isFinite(seconds) || seconds < 1 || seconds > 60 * 60 * 12) return null;
    return Math.round(seconds * 10) / 10;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}
