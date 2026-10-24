import { utf8 } from "./bytes.js";
import { LinkProtocolError } from "./messages.js";
import type { NoiseTransport } from "./noise.js";
import { encodeRecord, MAX_RECORD_PLAINTEXT, RECORD_HEADER_BYTES, RecordReader, splitRecords, type LinkRecord } from "./records.js";

const EMPTY = new Uint8Array(0);
/** Byte records wait while the socket holds this much, so a large image never delays a live frame by more. */
const BYTES_HIGH_WATER = 256 * 1024;
const RECORDS_PER_TURN = 4;
/** An end that leaves this much unread has stopped reading, so the session ends instead of queueing more. */
const MAX_UNREAD_BYTES = 8 * 1024 * 1024;
const BYTE_ROOM = MAX_RECORD_PLAINTEXT - RECORD_HEADER_BYTES;

/** WebSocket close codes either end sends. */
export const LinkCloseCode = {
  normal: 1000,
  /** Sent after a `closing` message: the Mac ended the session on purpose. */
  closing: 4000,
  refused: 4001,
  protocol: 4002,
  timeout: 4003,
  busy: 4004,
} as const;

/** What a session needs of a WebSocket. An adapter for `ws` or React Native's WebSocket is a few lines. */
export interface LinkSocket {
  send(data: Uint8Array): void;
  /** Bytes handed to `send` that are not on the network yet. */
  bufferedAmount(): number;
  close(code: number, reason: string): void;
  /** Sets the one listener for binary messages, replacing the previous one. */
  onMessage(listener: (data: Uint8Array) => void): void;
  /** Sets the one listener for the socket closing, replacing the previous one. */
  onClose(listener: (code: number, reason: string) => void): void;
}

interface OutgoingStream {
  id: number;
  bytes: Uint8Array;
  offset: number;
  sent(): void;
}

/**
 * One authenticated, encrypted session. Messages sent in the same tick travel as one record batch, in order. Byte
 * streams go out behind any JSON, a few records at a time. A record that fails to authenticate or parse ends the
 * session: the socket is ordered and reliable, so a tampered, replayed or reordered record is never retried.
 * Made by `connectLink` and `acceptLink`.
 */
export class LinkSession<In, Out> {
  private outbox: Out[] = [];
  private flushQueued = false;
  private streams: OutgoingStream[] = [];
  private pumpTimer: ReturnType<typeof setTimeout> | null = null;
  private ended = false;
  private readonly reader = new RecordReader();
  private readonly messageListeners = new Set<(message: In) => void>();
  private readonly bytesListeners = new Set<(stream: number, chunk: Uint8Array, end: boolean) => void>();
  private readonly closeListeners = new Set<(code: number, reason: string) => void>();

  constructor(
    private readonly socket: LinkSocket,
    private readonly transport: NoiseTransport,
    private readonly parse: (value: unknown) => In,
    /** The other end's static key, proven by the handshake. */
    readonly remoteStatic: Uint8Array,
  ) {
    socket.onMessage((data) => this.receive(data));
    socket.onClose((code, reason) => this.finish(code, reason));
  }

  get closed(): boolean {
    return this.ended;
  }

  send(message: Out): void {
    if (this.ended) return;
    this.outbox.push(message);
    if (this.flushQueued) return;
    this.flushQueued = true;
    queueMicrotask(() => this.flush());
  }

  /**
   * Streams `bytes` under `stream`; the receiver sees chunks in order, the last one marked. Resolves once the last
   * chunk is on the socket, or the session has ended.
   */
  sendBytes(stream: number, bytes: Uint8Array): Promise<void> {
    if (this.ended) return Promise.resolve();
    return new Promise((sent) => {
      this.streams.push({ id: stream, bytes, offset: 0, sent });
      this.pumpTimer ??= setTimeout(() => this.pump(), 0);
    });
  }

  /** What is waiting to reach the network: the socket's buffer and unsent stream bytes. */
  bufferedAmount(): number {
    let pending = this.socket.bufferedAmount();
    for (const stream of this.streams) pending += stream.bytes.length - stream.offset;
    return pending;
  }

  onMessage(listener: (message: In) => void): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onBytes(listener: (stream: number, chunk: Uint8Array, end: boolean) => void): () => void {
    this.bytesListeners.add(listener);
    return () => this.bytesListeners.delete(listener);
  }

  onClose(listener: (code: number, reason: string) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  /** Sends what is queued, then closes. Unsent byte streams are dropped. */
  close(code: number, reason = ""): void {
    if (this.ended) return;
    this.flush();
    this.finish(code, reason);
    this.socket.close(code, reason);
  }

  private flush(): void {
    this.flushQueued = false;
    if (this.ended || this.outbox.length === 0) return;
    if (this.socket.bufferedAmount() > MAX_UNREAD_BYTES) {
      this.outbox = [];
      this.close(LinkCloseCode.timeout, "stopped reading");
      return;
    }
    const batch = this.outbox;
    this.outbox = [];
    for (const record of splitRecords("json", 0, utf8(JSON.stringify(batch)))) this.write(record);
  }

  private pump(): void {
    this.pumpTimer = null;
    if (this.ended) return;
    this.flush();
    for (let sent = 0; sent < RECORDS_PER_TURN && this.streams.length > 0 && this.socket.bufferedAmount() < BYTES_HIGH_WATER; sent++) {
      // Round robin, so a small image is not stuck behind a large one.
      const stream = this.streams.shift()!;
      const body = stream.bytes.subarray(stream.offset, stream.offset + BYTE_ROOM);
      stream.offset += body.length;
      const end = stream.offset >= stream.bytes.length;
      this.write({ kind: "bytes", stream: stream.id, end, body });
      if (end) stream.sent();
      else this.streams.push(stream);
    }
    if (this.streams.length > 0) this.pumpTimer = setTimeout(() => this.pump(), this.socket.bufferedAmount() < BYTES_HIGH_WATER ? 0 : 5);
  }

  private write(record: LinkRecord): void {
    this.socket.send(this.transport.send.seal(EMPTY, encodeRecord(record)));
  }

  private receive(data: Uint8Array): void {
    if (this.ended) return;
    const plaintext = this.transport.receive.open(EMPTY, data);
    if (!plaintext) {
      this.close(LinkCloseCode.protocol, "record did not authenticate");
      return;
    }
    let messages: In[] = [];
    let received;
    try {
      received = this.reader.push(plaintext);
      if (received?.kind === "json") messages = parseBatch(received.text, this.parse);
    } catch (error) {
      this.close(LinkCloseCode.protocol, error instanceof LinkProtocolError ? error.message : "malformed message");
      return;
    }
    if (received?.kind === "bytes") for (const listener of this.bytesListeners) listener(received.stream, received.chunk, received.end);
    for (const message of messages) for (const listener of this.messageListeners) listener(message);
  }

  private finish(code: number, reason: string): void {
    if (this.ended) return;
    this.ended = true;
    if (this.pumpTimer) clearTimeout(this.pumpTimer);
    this.pumpTimer = null;
    for (const stream of this.streams) stream.sent();
    this.streams = [];
    this.outbox = [];
    for (const listener of this.closeListeners) listener(code, reason);
  }
}

function parseBatch<In>(text: string, parse: (value: unknown) => In): In[] {
  const values: unknown = JSON.parse(text);
  if (!Array.isArray(values) || values.length === 0) throw new LinkProtocolError("not a message batch");
  return values.map(parse);
}
