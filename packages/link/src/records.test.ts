import { describe, expect, it } from "vitest";
import { utf8 } from "./bytes.js";
import { decodeRecord, encodeRecord, RECORD_HEADER_BYTES, RecordReader, splitRecords, type Received } from "./records.js";

function seeded(seed: number) {
  return () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
    return seed / 2 ** 31;
  };
}

describe("records", () => {
  it("reassemble JSON and bytes cut at random record sizes", () => {
    const random = seeded(7);
    for (let round = 0; round < 60; round++) {
      const maxPlaintext = RECORD_HEADER_BYTES + 1 + Math.floor(random() * 70_000);
      const text = JSON.stringify([{ t: "ping", id: round, pad: "é".repeat(Math.floor(random() * 120_000)) }]);
      const reader = new RecordReader();
      const received = splitRecords("json", 0, utf8(text), maxPlaintext).map((record) => reader.push(encodeRecord(record)));
      expect(received.at(-1)).toEqual({ kind: "json", text });
      expect(received.slice(0, -1).every((item) => item === null)).toBe(true);

      const bytes = Uint8Array.from({ length: Math.floor(random() * 200_000) }, () => Math.floor(random() * 256));
      const chunks = splitRecords("bytes", 4, bytes, maxPlaintext).map((record) => reader.push(encodeRecord(record)) as Extract<Received, { kind: "bytes" }>);
      expect(chunks.map((chunk) => chunk.end)).toEqual(chunks.map((_, index) => index === chunks.length - 1));
      expect(Buffer.concat(chunks.map((chunk) => chunk.chunk)).equals(Buffer.from(bytes))).toBe(true);
    }
  });

  it("send an empty payload as one final record", () => {
    expect(splitRecords("bytes", 1, new Uint8Array(0))).toEqual([{ kind: "bytes", stream: 1, end: true, body: new Uint8Array(0) }]);
  });

  it("refuse headers that are not ours, JSON on a stream, and messages over the limit", () => {
    expect(() => decodeRecord(new Uint8Array(3))).toThrow("too short");
    expect(() => decodeRecord(Uint8Array.of(9, 1, 0, 0, 0, 0))).toThrow("unknown record header");
    expect(() => decodeRecord(Uint8Array.of(1, 2, 0, 0, 0, 0))).toThrow("unknown record header");
    expect(() => new RecordReader().push(encodeRecord({ kind: "json", stream: 3, end: true, body: utf8("[]") }))).toThrow("no stream");
    const small = new RecordReader(10);
    expect(() => small.push(encodeRecord({ kind: "json", stream: 0, end: false, body: new Uint8Array(11) }))).toThrow("too large");
    expect(() => new RecordReader().push(encodeRecord({ kind: "json", stream: 0, end: true, body: Uint8Array.of(0xff) }))).toThrow("not UTF-8");
  });
});
