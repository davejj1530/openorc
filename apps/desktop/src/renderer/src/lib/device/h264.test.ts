import { describe, expect, it } from "vitest";
import { AvccDemuxer, AvccFramingError, avcCodecString, parseSemuPacket, scanAccessUnit } from "./h264";

const envelope = (tag: number, payload: number[]) => {
  const length = 1 + payload.length;
  return [(length >>> 24) & 0xff, (length >>> 16) & 0xff, (length >>> 8) & 0xff, length & 0xff, tag, ...payload];
};

describe("AvccDemuxer", () => {
  const stream = Uint8Array.from([...envelope(4, [0xff, 0xd8, 0xff, 0xd9]), ...envelope(1, [1, 0x64, 0x00, 0x33]), ...envelope(2, [9, 9, 9]), ...envelope(0x7f, [0]), ...envelope(3, [4])]);

  it("yields the seed, description, keyframe and delta in order wherever the body splits, skipping unknown tags", () => {
    for (let split = 0; split <= stream.length; split++) {
      const demuxer = new AvccDemuxer();
      const chunks = [...demuxer.push(stream.subarray(0, split)), ...demuxer.push(stream.subarray(split))];
      expect(chunks.map((chunk) => chunk.type)).toEqual(["seed", "description", "keyframe", "delta"]);
      expect(chunks.map((chunk) => Array.from(chunk.payload))).toEqual([[0xff, 0xd8, 0xff, 0xd9], [1, 0x64, 0x00, 0x33], [9, 9, 9], [4]]);
    }
  });

  it("holds an envelope larger than its starting buffer until every byte is in", () => {
    const large = Array.from({ length: 200_000 }, (_, index) => index & 0xff);
    const bytes = Uint8Array.from(envelope(2, large));
    const demuxer = new AvccDemuxer();
    expect(demuxer.push(bytes.subarray(0, 100_000))).toEqual([]);
    const [chunk] = demuxer.push(bytes.subarray(100_000));
    expect(chunk?.payload).toEqual(Uint8Array.from(large));
  });

  it("refuses a length no device sends instead of buffering forever", () => {
    expect(() => new AvccDemuxer().push(Uint8Array.of(0x7f, 0xff, 0xff, 0xff, 2))).toThrow(AvccFramingError);
  });
});

it("derives the WebCodecs codec string from an avcC record", () => {
  expect(avcCodecString(Uint8Array.of(1, 0x64, 0x00, 0x33))).toBe("avc1.640033");
  expect(avcCodecString(Uint8Array.of(1))).toBe("avc1.42E01E");
});

describe("serve-emu frames", () => {
  it("strips the SEMU header and reads the keyframe flag and timestamp", () => {
    const bytes = new Uint8Array(16 + 3);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, 0x53454d55);
    view.setUint8(4, 1);
    view.setUint8(5, 1);
    view.setBigUint64(8, 123456n);
    bytes.set([7, 8, 9], 16);
    const packet = parseSemuPacket(bytes);
    expect(packet).toEqual({ data: Uint8Array.of(7, 8, 9), isKey: true, timestamp: 123456 });
  });

  it("reads a header that sits inside a larger buffer", () => {
    const backing = new Uint8Array(4 + 16 + 1);
    const view = new DataView(backing.buffer, 4);
    view.setUint32(0, 0x53454d55);
    view.setUint8(4, 1);
    view.setUint8(5, 0);
    backing[20] = 0x41;
    expect(parseSemuPacket(backing.subarray(4))).toEqual({ data: Uint8Array.of(0x41), isKey: false, timestamp: 0 });
  });

  it("treats a frame without the header as raw data with unknown flags", () => {
    const packet = parseSemuPacket(Uint8Array.of(0, 0, 1, 0x65));
    expect(packet.isKey).toBeNull();
    expect(packet.data).toHaveLength(4);
  });

  it("finds the SPS and IDR in an Annex B access unit", () => {
    const unit = Uint8Array.of(0, 0, 0, 1, 0x67, 0x64, 0x00, 0x1f, 0, 0, 1, 0x65, 0xaa);
    const scanned = scanAccessUnit(unit);
    expect(scanned.isKey).toBe(true);
    expect(scanned.sps && avcCodecString(scanned.sps)).toBe("avc1.64001f");
    expect(scanAccessUnit(Uint8Array.of(0, 0, 1, 0x41, 0x00))).toEqual({ isKey: false, sps: null });
  });
});
