import { crc32, inflateSync } from "node:zlib";
import { expect, it } from "vitest";
import { icoPng } from "./project-icon-ico";

const tinyPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD1sAAAAASUVORK5CYII=", "base64");
function pack(images: { bytes: Buffer; width: number; height: number }[]): Buffer {
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach((frame, i) => {
    const entry = 6 + 16 * i;
    header[entry] = frame.width % 256;
    header[entry + 1] = frame.height % 256;
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(frame.bytes.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += frame.bytes.length;
  });
  return Buffer.concat([header, ...images.map((frame) => frame.bytes)]);
}

function dib(bits = 32, height = 2, colors = 0): Buffer {
  const stride = Math.ceil((2 * bits) / 32) * 4;
  const bytes = Buffer.alloc(40 + colors * 4 + stride * height + 4 * height);
  bytes.writeUInt32LE(40, 0);
  bytes.writeInt32LE(2, 4);
  bytes.writeInt32LE(height * 2, 8);
  bytes.writeUInt16LE(1, 12);
  bytes.writeUInt16LE(bits, 14);
  bytes.writeUInt32LE(colors, 32);
  return bytes;
}

function pixels(bytes: Buffer, width = 2, height = 2): number[] {
  const png = icoPng(pack([{ bytes, width, height }]));
  expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([width, height]);
  const image: Buffer[] = [];
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset);
    expect(crc32(png.subarray(offset + 4, offset + 8 + length))).toBe(png.readUInt32BE(offset + 8 + length));
    if (png.toString("ascii", offset + 4, offset + 8) === "IDAT") image.push(png.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  const rows = inflateSync(Buffer.concat(image));
  const result: number[] = [];
  for (let y = 0; y < height; y++) {
    const start = y * (width * 4 + 1);
    expect(rows[start]).toBe(0);
    result.push(...rows.subarray(start + 1, start + 1 + width * 4));
  }
  return result;
}

it("unwraps PNG-compressed ICOs without altering their image", () => {
  expect(icoPng(pack([{ bytes: tinyPng, width: 1, height: 1 }]))).toEqual(tinyPng);
});

it("preserves bitmap colors, bottom-up orientation, and fractional alpha", () => {
  const bytes = dib();
  bytes.set([255, 0, 0, 255, 255, 255, 255, 128, 0, 0, 255, 255, 0, 255, 0, 0], 40);
  expect(pixels(bytes)).toEqual([255, 0, 0, 255, 0, 255, 0, 0, 0, 0, 255, 255, 255, 255, 255, 128]);
});

it("uses the AND mask for legacy 32-bit icons with zero alpha", () => {
  const bytes = dib();
  bytes.set([255, 0, 0, 0, 255, 255, 255, 0, 0, 0, 255, 0, 0, 255, 0, 0], 40);
  bytes[60] = 0x40; // Top row, second pixel transparent.
  expect(pixels(bytes)).toEqual([255, 0, 0, 255, 0, 255, 0, 0, 0, 0, 255, 255, 255, 255, 255, 255]);
});

it.each([1, 4, 8])("decodes a %i-bit palette and transparency", (bits) => {
  const bytes = dib(bits, 1, 2);
  bytes.set([0, 0, 255, 0, 255, 0, 0, 0], 40); // Red and blue palette entries.
  if (bits === 1) bytes[48] = 0x40;
  if (bits === 4) bytes[48] = 0x01;
  if (bits === 8) bytes[49] = 0x01;
  bytes[52] = 0x80;
  expect(pixels(bytes, 2, 1)).toEqual([255, 0, 0, 0, 0, 0, 255, 255]);
});

it("decodes padded 24-bit rows and 16-bit RGB", () => {
  const rgb = dib(24, 1);
  rgb.set([0, 0, 255, 0, 255, 0, 77, 77], 40);
  expect(pixels(rgb, 2, 1)).toEqual([255, 0, 0, 255, 0, 255, 0, 255]);
  const packed = dib(16, 1);
  packed.writeUInt16LE(0x7c00, 40);
  packed.writeUInt16LE(0x03e0, 42);
  expect(pixels(packed, 2, 1)).toEqual([255, 0, 0, 255, 0, 255, 0, 255]);
});

it("skips invalid frame ranges and mismatched PNG sizes while retaining a valid frame", () => {
  const icon = pack([
    { bytes: tinyPng, width: 64, height: 64 },
    { bytes: tinyPng, width: 1, height: 1 },
  ]);
  expect(icoPng(icon)).toEqual(tinyPng);
  icon.writeUInt32LE(0xffffffff, 18);
  expect(icoPng(icon)).toEqual(tinyPng);
});

it("rejects truncated directories, unbounded frame counts, and truncated bitmap data", () => {
  const icon = pack([{ bytes: tinyPng, width: 1, height: 1 }]);
  expect(() => icoPng(icon.subarray(0, 20))).toThrow();
  icon.writeUInt16LE(33, 4);
  expect(() => icoPng(icon)).toThrow("directory");
  expect(() => icoPng(pack([{ bytes: dib().subarray(0, 45), width: 2, height: 2 }]))).toThrow("no supported");
  expect(() => icoPng(pack([{ bytes: dib().subarray(0, 60), width: 2, height: 2 }]))).toThrow("no supported");
});

it("rejects oversized headers and unsupported bitmap compression before allocation", () => {
  const bytes = dib();
  bytes.writeInt32LE(1000000, 4);
  expect(() => icoPng(pack([{ bytes, width: 2, height: 2 }]))).toThrow("no supported");
  bytes.writeInt32LE(2, 4);
  bytes.writeUInt32LE(3, 16);
  expect(() => icoPng(pack([{ bytes, width: 2, height: 2 }]))).toThrow("no supported");
});
