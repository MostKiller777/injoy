/**
 * Codec probe for MPEG-TS.
 *
 * Media Source Extensions will not create a SourceBuffer from a bare
 * `video/mp2t` — it needs a codec list, and the playlist does not carry one.
 * The transport stream does: the PMT names every elementary stream by type, and
 * the first few packets of a segment are enough to read it. Without this the
 * player would have to guess, and a guess is a black frame when it is wrong.
 */

const PACKET = 188;
const SYNC = 0x47;

// ISO/IEC 13818-1 stream_type values that appear in the wild on these CDNs.
const VIDEO_CODECS = {
  0x01: 'avc1.42E01E', // MPEG-1 video, rarely seen but harmless to name
  0x02: 'avc1.42E01E', // MPEG-2 video
  0x1b: 'avc1.42E01E', // H.264
  0x24: 'hev1.1.6.L120.90', // HEVC
  0x27: 'hev1.1.6.L120.90',
  0x42: 'av01.0.05M.08', // AV1
};

const AUDIO_CODECS = {
  0x03: 'mp4a.40.34', // MPEG-1 audio
  0x04: 'mp4a.40.34', // MPEG-2 audio
  0x0f: 'mp4a.40.2', // AAC ADTS
  0x11: 'mp4a.40.2', // AAC LATM
  0x81: 'ac-3',
  0x87: 'ec-3',
};

function findSync(buffer) {
  const limit = Math.min(buffer.length - PACKET * 3, 64 * 1024);
  for (let offset = 0; offset < limit; offset += 1) {
    if (buffer[offset] !== SYNC) continue;
    if (buffer[offset + PACKET] !== SYNC) continue;
    if (buffer[offset + PACKET * 2] !== SYNC) continue;
    return offset;
  }
  return -1;
}

function payloadAt(buffer, pos) {
  const adaptation = (buffer[pos + 3] >> 4) & 0x03;
  let offset = pos + 4;
  if (adaptation === 2 || adaptation === 3) offset += 1 + buffer[pos + 4];
  return offset < pos + PACKET ? offset : -1;
}

/** Walk one PSI section out of a packet payload. */
function section(buffer, payload, pid) {
  if (payload < 0 || payload + 3 >= buffer.length) return null;
  // A PUSI packet starts with pointer_field; sections after it are skipped.
  const start = payload + 1 + buffer[payload];
  if (start + 3 >= buffer.length) return null;
  const length = ((buffer[start + 1] & 0x0f) << 8) | buffer[start + 2];
  if (length < 9 || start + 3 + length > buffer.length) return null;
  return { tableId: buffer[start], bytes: buffer.subarray(start, start + 3 + length), pid };
}

/**
 * Read the PMT and return `{ video, audio }` codec strings, or null when the
 * buffer does not contain one (a mid-GOP slice, an encrypted segment, or
 * something that is not a transport stream at all).
 */
export function probeTsCodecs(buffer) {
  const start = findSync(buffer);
  if (start === -1) return null;

  let pmtPid = null;
  let video = null;
  let audio = null;

  for (let pos = start; pos + PACKET <= buffer.length; pos += PACKET) {
    if (buffer[pos] !== SYNC) break;
    const pid = ((buffer[pos + 1] & 0x1f) << 8) | buffer[pos + 2];
    const pusi = (buffer[pos + 1] & 0x40) !== 0;
    if (!pusi) continue;

    const payload = payloadAt(buffer, pos);
    const psi = section(buffer, payload, pid);
    if (!psi) continue;

    if (pid === 0 && psi.tableId === 0x00 && pmtPid === null) {
      // PAT: program_number at 8, program_map_PID at 10.
      const bytes = psi.bytes;
      for (let i = 8; i + 3 < bytes.length - 4; i += 4) {
        const program = (bytes[i] << 8) | bytes[i + 1];
        if (program === 0) continue;
        pmtPid = ((bytes[i + 2] & 0x1f) << 8) | bytes[i + 3];
        break;
      }
      continue;
    }

    if (pid === pmtPid && psi.tableId === 0x02) {
      const bytes = psi.bytes;
      const infoLength = ((bytes[10] & 0x0f) << 8) | bytes[11];
      let at = 12 + infoLength;
      const end = bytes.length - 4; // CRC32
      while (at + 4 < end) {
        const type = bytes[at];
        const esInfoLength = ((bytes[at + 3] & 0x0f) << 8) | bytes[at + 4];
        if (!video && VIDEO_CODECS[type]) video = VIDEO_CODECS[type];
        if (!audio && AUDIO_CODECS[type]) audio = AUDIO_CODECS[type];
        at += 5 + esInfoLength;
      }
      break;
    }
  }

  if (!video) return null;
  return { video, audio };
}

/** `video/mp2t; codecs="..."` from a probe result, or a conservative default. */
export function tsMime(codecs) {
  if (!codecs?.video) return 'video/mp2t; codecs="avc1.42E01E,mp4a.40.2"';
  const list = codecs.audio ? `${codecs.video},${codecs.audio}` : codecs.video;
  return `video/mp2t; codecs="${list}"`;
}
