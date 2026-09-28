import { crc32, deflateSync } from "node:zlib";
import { imageSize } from "image-size";

const pngSignature = Buffer.from("89504e470d0a1a0a", "hex");
interface IconFrame {
  bytes: Buffer;
  width: number;
  height: number;
}

function frames(bytes: Buffer): IconFrame[] {
  if (bytes.length < 6 || bytes.length > 2 * 1024 * 1024 || bytes.readUInt16LE(0) !== 0 || bytes.readUInt16LE(2) !== 1) throw new Error("Invalid ICO header.");
  const count = bytes.readUInt16LE(4);
  const directoryEnd = 6 + count * 16;
  if (!count || count > 32 || directoryEnd > bytes.length) throw new Error("Invalid ICO directory.");
  const result: IconFrame[] = [];
  for (let i = 0; i < count; i++) {
    const entry = 6 + i * 16;
    const size = bytes.readUInt32LE(entry + 8);
    const offset = bytes.readUInt32LE(entry + 12);
    if (!size || offset < directoryEnd || offset + size > bytes.length) continue;
    result.push({ bytes: bytes.subarray(offset, offset + size), width: bytes[entry] || 256, height: bytes[entry + 1] || 256 });
  }
  // Choose a frame close to the thumbnail size, slightly preferring downscaling.
  const distance = (frame: IconFrame) => {
    const size = Math.max(frame.width, frame.height);
    return size >= 64 ? size - 64 : (64 - size) * 2;
  };
  return result.sort((a, b) => distance(a) - distance(b));
}

function chunk(type: string, data: Buffer): Buffer {
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length, 0);
  result.write(type, 4, 4, "ascii");
  data.copy(result, 8);
  result.writeUInt32BE(crc32(result.subarray(4, -4)), result.length - 4);
  return result;
}

/** A tiny bounded PNG encoder lets Electron decode bitmap ICOs on every platform. */
function png(width: number, height: number, rows: Buffer): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6; // RGBA, one unfiltered scanline per row.
  return Buffer.concat([pngSignature, chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

interface Bitmap {
  bytes: Buffer;
  width: number;
  height: number;
  bits: number;
  header: number;
  colors: number;
  pixels: number;
  stride: number;
  mask: number;
  maskStride: number;
  alpha: boolean;
}

function paletteSize(bytes: Buffer, bits: number): number {
  if (bits > 8) return 0;
  const colors = bytes.readUInt32LE(32) || 1 << bits;
  if (colors > 1 << bits) throw new Error("Invalid ICO palette.");
  return colors;
}

function bitmap(frame: IconFrame): Bitmap {
  const { bytes, width, height } = frame;
  if (bytes.length < 40) throw new Error("Truncated ICO bitmap.");
  const header = bytes.readUInt32LE(0);
  const bits = bytes.readUInt16LE(14);
  if (![40, 108, 124].includes(header) || header > bytes.length || ![1, 4, 8, 16, 24, 32].includes(bits)) throw new Error("Unsupported ICO bitmap.");
  if (bytes.readInt32LE(4) !== width || bytes.readInt32LE(8) !== height * 2 || bytes.readUInt16LE(12) !== 1 || bytes.readUInt32LE(16) !== 0)
    throw new Error("Invalid ICO bitmap dimensions or compression.");
  const colors = paletteSize(bytes, bits);
  const pixels = header + colors * 4;
  const stride = Math.ceil((width * bits) / 32) * 4;
  const mask = pixels + stride * height;
  const maskStride = Math.ceil(width / 32) * 4;
  if (mask > bytes.length) throw new Error("Truncated ICO pixels.");
  // Older 32-bit icons leave all alpha bytes zero and use the transparency mask.
  const alpha = bits === 32 && bytes.subarray(pixels, mask).some((value, index) => index % 4 === 3 && value !== 0);
  if (!alpha && mask + maskStride * height > bytes.length) throw new Error("Truncated ICO mask.");
  return { bytes, width, height, bits, header, colors, pixels, stride, mask, maskStride, alpha };
}

function color(b: Bitmap, row: number, x: number): [number, number, number] {
  const offset = row + Math.floor((x * b.bits) / 8);
  if (b.bits >= 24) return [b.bytes[offset + 2]!, b.bytes[offset + 1]!, b.bytes[offset]!];
  if (b.bits === 16) {
    const value = b.bytes.readUInt16LE(offset);
    const expand = (channel: number) => Math.round((channel * 255) / 31);
    return [expand((value >> 10) & 31), expand((value >> 5) & 31), expand(value & 31)];
  }
  const index = (b.bytes[offset]! >> (8 - b.bits - ((x * b.bits) % 8))) & ((1 << b.bits) - 1);
  if (index >= b.colors) throw new Error("Invalid ICO palette index.");
  const entry = b.header + index * 4;
  return [b.bytes[entry + 2]!, b.bytes[entry + 1]!, b.bytes[entry]!];
}

function bitmapPng(frame: IconFrame): Buffer {
  const b = bitmap(frame);
  const rowSize = b.width * 4 + 1;
  const rows = Buffer.alloc(rowSize * b.height);
  for (let y = 0; y < b.height; y++) {
    const sourceY = b.height - y - 1; // DIB pixels and masks are stored bottom-up.
    const source = b.pixels + sourceY * b.stride;
    for (let x = 0; x < b.width; x++) {
      const target = y * rowSize + 1 + x * 4;
      const rgb = color(b, source, x);
      rows.set(rgb, target);
      let alpha = 255;
      if (b.alpha) alpha = b.bytes[source + x * 4 + 3]!;
      else if (b.bytes[b.mask + sourceY * b.maskStride + (x >> 3)]! & (0x80 >> (x % 8))) alpha = 0;
      rows[target + 3] = alpha;
    }
  }
  return png(b.width, b.height, rows);
}

/** ICO is a container, not a portable nativeImage input. Decode one bounded frame. */
export function icoPng(bytes: Buffer): Buffer {
  for (const frame of frames(bytes)) {
    try {
      if (!frame.bytes.subarray(0, 8).equals(pngSignature)) return bitmapPng(frame);
      const size = imageSize(frame.bytes);
      if (size.width === frame.width && size.height === frame.height) return frame.bytes;
    } catch {
      // One malformed or unsupported frame need not hide another valid size.
    }
  }
  throw new Error("This ICO has no supported image frame.");
}
