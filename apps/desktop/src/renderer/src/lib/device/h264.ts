/**
 * The two H.264 framings the device hub serves. iOS: an HTTP body of AVCC envelopes (a 4-byte length, a 1-byte tag,
 * the payload), with a JPEG seed first. Android: one WebSocket message per access unit, each behind a 16-byte SEMU
 * header carrying the keyframe flag and presentation time.
 */

export type AvccChunk = { type: "description" | "keyframe" | "delta" | "seed"; payload: Uint8Array<ArrayBuffer> };

const AVCC_TAGS: Record<number, AvccChunk["type"] | undefined> = { 1: "description", 2: "keyframe", 3: "delta", 4: "seed" };

/** Far above a simulator's JPEG seed (about 400 KB): a longer envelope means the stream lost its framing. */
const MAX_ENVELOPE_BYTES = 32 * 1024 * 1024;

export class AvccFramingError extends Error {}

/** Reassembles AVCC envelopes from body chunks that split them anywhere. Unknown tags are skipped. */
export class AvccDemuxer {
  private buffer: Uint8Array<ArrayBuffer> = new Uint8Array(64 * 1024);
  private length = 0;

  push(bytes: Uint8Array): AvccChunk[] {
    this.append(bytes);
    const chunks: AvccChunk[] = [];
    let offset = 0;
    while (this.length - offset >= 4) {
      const envelope = new DataView(this.buffer.buffer, this.buffer.byteOffset + offset, 4).getUint32(0, false);
      if (envelope > MAX_ENVELOPE_BYTES) throw new AvccFramingError(`AVCC envelope of ${envelope} bytes`);
      if (this.length - offset - 4 < envelope) break;
      const type = envelope >= 1 ? AVCC_TAGS[this.buffer[offset + 4]!] : undefined;
      if (type) chunks.push({ type, payload: this.buffer.slice(offset + 5, offset + 4 + envelope) });
      offset += 4 + envelope;
    }
    if (offset > 0) {
      this.buffer.copyWithin(0, offset, this.length);
      this.length -= offset;
    }
    return chunks;
  }

  private append(bytes: Uint8Array): void {
    if (this.length + bytes.length > this.buffer.length) {
      let capacity = this.buffer.length;
      while (capacity < this.length + bytes.length) capacity *= 2;
      const grown = new Uint8Array(capacity);
      grown.set(this.buffer.subarray(0, this.length));
      this.buffer = grown;
    }
    this.buffer.set(bytes, this.length);
    this.length += bytes.length;
  }
}

/** The WebCodecs codec string for an avcC record or an SPS NAL: profile, constraints and level as hex. */
export function avcCodecString(bytes: Uint8Array): string {
  if (bytes.length < 4) return "avc1.42E01E";
  const hex = (byte: number) => byte.toString(16).padStart(2, "0");
  return `avc1.${hex(bytes[1]!)}${hex(bytes[2]!)}${hex(bytes[3]!)}`;
}

export type SemuPacket = { data: Uint8Array<ArrayBuffer>; isKey: boolean | null; timestamp: number | null };

const SEMU_MAGIC = 0x53454d55;
const SEMU_HEADER_BYTES = 16;

/** Strips the SEMU header when there is one. Without it the packet is raw Annex B and its flags are unknown. */
export function parseSemuPacket(bytes: Uint8Array<ArrayBuffer>): SemuPacket {
  if (bytes.byteLength > SEMU_HEADER_BYTES) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, SEMU_HEADER_BYTES);
    if (view.getUint32(0, false) === SEMU_MAGIC && view.getUint8(4) === 1) {
      const pts = view.getBigUint64(8, false);
      return {
        data: bytes.subarray(SEMU_HEADER_BYTES),
        isKey: (view.getUint8(5) & 1) !== 0,
        timestamp: pts <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(pts) : null,
      };
    }
  }
  return { data: bytes, isKey: null, timestamp: null };
}

const startCodeLength = (buf: Uint8Array, i: number): number => {
  if (buf[i] !== 0 || buf[i + 1] !== 0) return 0;
  if (buf[i + 2] === 1) return 3;
  return i + 3 < buf.length && buf[i + 2] === 0 && buf[i + 3] === 1 ? 4 : 0;
};

/** Finds the first SPS and whether an IDR slice is present in an Annex B access unit. */
export function scanAccessUnit(buf: Uint8Array): { isKey: boolean; sps: Uint8Array | null } {
  let isKey = false;
  let sps: Uint8Array | null = null;
  let i = 0;
  while (i + 2 < buf.length) {
    const code = startCodeLength(buf, i);
    if (code === 0) {
      i++;
      continue;
    }
    const nalType = buf[i + code]! & 0x1f;
    if (nalType === 7 && !sps) sps = buf.subarray(i + code);
    if (nalType === 5) isKey = true;
    i += code + 1;
  }
  return { isKey, sps };
}
