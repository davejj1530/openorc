import { concat, fromUtf8 } from "./bytes.js";
import { TAG_BYTES } from "./crypto.js";
import { LinkProtocolError } from "./messages.js";

/*
 * One WebSocket message is one sealed record. Inside, a header says what the body is:
 *
 *   [kind u8][flags u8][stream u32 big-endian][body]
 *
 * JSON records carry a slice of one JSON array of messages and never interleave with each other. Byte records carry
 * a slice of an asset under the stream id of the request that asked for it, so they can sit between JSON records.
 * Flag bit 0 marks the last record of a message or stream.
 */

/** The Noise message limit, less the tag. */
export const MAX_RECORD_PLAINTEXT = 65_535 - TAG_BYTES;
export const RECORD_HEADER_BYTES = 6;
/** The largest JSON message either end will reassemble. */
export const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

export type RecordKind = "json" | "bytes";

export interface LinkRecord {
  kind: RecordKind;
  stream: number;
  end: boolean;
  body: Uint8Array;
}

const KIND_CODES: Record<RecordKind, number> = { json: 1, bytes: 2 };
const KINDS: Record<number, RecordKind> = { 1: "json", 2: "bytes" };
const END = 1;

export function encodeRecord({ kind, stream, end, body }: LinkRecord): Uint8Array {
  const out = new Uint8Array(RECORD_HEADER_BYTES + body.length);
  out[0] = KIND_CODES[kind];
  out[1] = end ? END : 0;
  new DataView(out.buffer).setUint32(2, stream);
  out.set(body, RECORD_HEADER_BYTES);
  return out;
}

export function decodeRecord(plaintext: Uint8Array): LinkRecord {
  if (plaintext.length < RECORD_HEADER_BYTES) throw new LinkProtocolError("record is too short");
  const kind = KINDS[plaintext[0]!];
  const flags = plaintext[1]!;
  if (!kind || (flags & ~END) !== 0) throw new LinkProtocolError("unknown record header");
  const stream = new DataView(plaintext.buffer, plaintext.byteOffset, plaintext.byteLength).getUint32(2);
  return { kind, stream, end: (flags & END) !== 0, body: plaintext.subarray(RECORD_HEADER_BYTES) };
}

/** Cuts one message or asset into records no larger than `maxPlaintext`; an empty payload is one empty, final record. */
export function splitRecords(kind: RecordKind, stream: number, payload: Uint8Array, maxPlaintext = MAX_RECORD_PLAINTEXT): LinkRecord[] {
  const room = maxPlaintext - RECORD_HEADER_BYTES;
  const records: LinkRecord[] = [];
  let offset = 0;
  do {
    const body = payload.subarray(offset, offset + room);
    offset += body.length;
    records.push({ kind, stream, end: offset >= payload.length, body });
  } while (offset < payload.length);
  return records;
}

export type Received = { kind: "json"; text: string } | { kind: "bytes"; stream: number; chunk: Uint8Array; end: boolean };

/** Reassembles JSON messages from their records. Byte records pass straight through. Throws LinkProtocolError. */
export class RecordReader {
  private parts: Uint8Array[] = [];
  private bytes = 0;

  constructor(private readonly maxMessageBytes = MAX_MESSAGE_BYTES) {}

  push(plaintext: Uint8Array): Received | null {
    const record = decodeRecord(plaintext);
    if (record.kind === "bytes") return { kind: "bytes", stream: record.stream, chunk: record.body, end: record.end };
    if (record.stream !== 0) throw new LinkProtocolError("JSON records have no stream");
    this.bytes += record.body.length;
    if (this.bytes > this.maxMessageBytes) throw new LinkProtocolError("message is too large");
    this.parts.push(record.body);
    if (!record.end) return null;
    const whole = this.parts.length === 1 ? this.parts[0]! : concat(...this.parts);
    this.parts = [];
    this.bytes = 0;
    try {
      return { kind: "json", text: fromUtf8(whole) };
    } catch {
      throw new LinkProtocolError("message is not UTF-8");
    }
  }
}
