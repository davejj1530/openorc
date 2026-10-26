/**
 * The simulator's fallback encoder omits the SPS VUI that declares it never reorders frames. Chromium's hardware
 * decoder then holds frames back for seconds despite `optimizeForLatency`. Adding the VUI with zero reorder frames
 * keeps hardware decoding at live latency. Anything this parser does not fully understand passes through unchanged.
 */

const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_SPS_BYTES = 4096;

class BitReader {
  position = 0;
  constructor(readonly bits: string) {}

  read(count: number): number {
    if (this.position + count > this.bits.length) throw new Error("Truncated H.264 SPS");
    const value = Number.parseInt(this.bits.slice(this.position, this.position + count), 2);
    this.position += count;
    return value;
  }

  /** Unsigned Exp-Golomb. */
  ue(): number {
    let leadingZeros = 0;
    while (this.read(1) === 0) {
      if (++leadingZeros > 31) throw new Error("Invalid H.264 Exp-Golomb value");
    }
    return 2 ** leadingZeros - 1 + (leadingZeros === 0 ? 0 : this.read(leadingZeros));
  }
}

const unsignedGolomb = (value: number) => {
  const bits = (value + 1).toString(2);
  return "0".repeat(bits.length - 1) + bits;
};

/** The RBSP after the NAL header as a bit string, with emulation prevention bytes removed. Null when malformed. */
function rbspBits(sps: Uint8Array): string | null {
  const rbsp: number[] = [];
  let zeros = 0;
  for (let index = 1; index < sps.length; index++) {
    const byte = sps[index]!;
    if (zeros >= 2 && byte === 3) {
      if (index + 1 >= sps.length || sps[index + 1]! > 3) return null;
      zeros = 0;
      continue;
    }
    rbsp.push(byte);
    zeros = byte === 0 ? zeros + 1 : 0;
  }
  return rbsp.map((byte) => byte.toString(2).padStart(8, "0")).join("");
}

/** The hub's 8-bit 4:2:0 High profile without scaling lists, through log2_max_frame_num. */
function readHighProfileHeader(r: BitReader): boolean {
  if (r.read(8) !== 100) return false;
  r.read(16);
  if (r.ue() > 31 || r.ue() !== 1) return false;
  if (r.ue() !== 0 || r.ue() !== 0) return false;
  r.read(1);
  if (r.read(1) !== 0) return false;
  return r.ue() <= 12;
}

function skipPictureOrderCount(r: BitReader): boolean {
  const type = r.ue();
  if (type === 0) return r.ue() <= 12;
  if (type === 2) return true;
  if (type !== 1) return false;
  r.read(1);
  r.ue();
  r.ue();
  const cycle = r.ue();
  if (cycle > 255) return false;
  for (let index = 0; index < cycle; index++) r.ue();
  return true;
}

/** Reads through the cropping fields and returns max_num_ref_frames, or null for values out of range. */
function readFrameLayout(r: BitReader): number | null {
  const maxReferenceFrames = r.ue();
  if (maxReferenceFrames > 16) return null;
  r.read(1);
  if (r.ue() > 65535 || r.ue() > 65535) return null;
  if (r.read(1) === 0) r.read(1);
  r.read(1);
  if (r.read(1) !== 0) for (let index = 0; index < 4; index++) r.ue();
  return maxReferenceFrames;
}

/** Packs bits after the NAL header byte, adding emulation prevention bytes back. */
function escapeRbsp(header: number, bits: string): Uint8Array {
  const padded = bits.padEnd(Math.ceil(bits.length / 8) * 8, "0");
  const output = [header];
  let zeros = 0;
  for (let index = 0; index < padded.length; index += 8) {
    const byte = Number.parseInt(padded.slice(index, index + 8), 2);
    if (zeros >= 2 && byte <= 3) {
      output.push(3);
      zeros = 0;
    }
    output.push(byte);
    zeros = byte === 0 ? zeros + 1 : 0;
  }
  return Uint8Array.from(output);
}

function withReorderLimits(sps: Uint8Array): Uint8Array {
  if (sps.length < 4 || sps.length > MAX_SPS_BYTES || (sps[0]! & 0x9f) !== 7) return sps;
  const bits = rbspBits(sps);
  if (bits === null) return sps;
  const r = new BitReader(bits);
  try {
    if (!readHighProfileHeader(r) || !skipPictureOrderCount(r)) return sps;
    const maxReferenceFrames = readFrameLayout(r);
    if (maxReferenceFrames === null) return sps;
    const vuiPosition = r.position;
    if (r.read(1) !== 0) return sps;
    // With no VUI, only rbsp_stop_one_bit and byte padding may follow.
    if (!/^10{0,7}$/.test(bits.slice(r.position))) return sps;
    // VUI present, eight optional sections absent, bitstream_restriction and motion_vectors_over_pic_boundaries on,
    // then the restriction values with zero reorder frames, then the stop bit.
    const restriction = [2, 1, 16, 16, 0, maxReferenceFrames].map(unsignedGolomb).join("");
    return escapeRbsp(sps[0]!, `${bits.slice(0, vuiPosition)}10000000011${restriction}1`);
  } catch {
    return sps;
  }
}

type ParameterSets = { prefix: Uint8Array; sps: Uint8Array[]; suffix: Uint8Array };

function readLengthPrefixed(description: Uint8Array, position: number): { bytes: Uint8Array; next: number } | null {
  if (position + 2 > description.length) return null;
  const length = description[position]! * 256 + description[position + 1]!;
  const start = position + 2;
  if (length === 0 || start + length > description.length) return null;
  return { bytes: description.subarray(start, start + length), next: start + length };
}

/** Splits an avcC record into its fixed prefix, its SPS entries and everything after them, checking every length. */
function parameterSets(description: Uint8Array): ParameterSets | null {
  const sps: Uint8Array[] = [];
  let position = 6;
  for (let index = 0; index < (description[5]! & 0x1f); index++) {
    const entry = readLengthPrefixed(description, position);
    if (!entry) return null;
    sps.push(entry.bytes);
    position = entry.next;
  }
  const suffixStart = position;
  if (position >= description.length) return null;
  const pictureParameterSets = description[position++]!;
  for (let index = 0; index < pictureParameterSets; index++) {
    const entry = readLengthPrefixed(description, position);
    if (!entry) return null;
    position = entry.next;
  }
  return { prefix: description.subarray(0, 6), sps, suffix: description.subarray(suffixStart) };
}

/** Repairs missing reorder metadata in the simulator's avcC record. Returns the same array when nothing changed. */
export function simulatorAvcConfig(description: Uint8Array): Uint8Array {
  if (description.length < 7 || description.length > MAX_CONFIG_BYTES || description[0] !== 1) return description;
  if ((description[5]! & 0x1f) === 0) return description;
  const sets = parameterSets(description);
  if (!sets) return description;
  const repaired = sets.sps.map(withReorderLimits);
  if (repaired.every((sps, index) => sps === sets.sps[index])) return description;
  const parts = [sets.prefix, ...repaired.flatMap((sps) => [Uint8Array.of(sps.length >>> 8, sps.length & 0xff), sps]), sets.suffix];
  const output = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}
