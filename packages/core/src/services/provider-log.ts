import { createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, statSync, type WriteStream } from "node:fs";
import path from "node:path";
import { redactJson } from "@openorc/db";
import type { AgentEvent } from "@openorc/protocol";

type RawEvent = Extract<AgentEvent, { type: "raw" }>;

export interface ProviderLogOptions {
  /** A file is closed and a new one started past this size. */
  maxFileBytes?: number;
  /** The oldest files are removed while the folder holds more than this. */
  maxTotalBytes?: number;
  /** Files last written longer ago than this are removed. */
  maxAgeMs?: number;
  /** A longer line is replaced by its first bytes and its size. */
  maxRecordBytes?: number;
  /** A file is closed and a new one started once it is this old, so age limits hold even for a quiet log. */
  maxFileAgeMs?: number;
  now?: () => number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Whether a native line is one token-sized piece of a stream. The finished message, tool result or usage line that
 * follows carries what these add up to, so the log keeps those and skips the pieces.
 */
export function isStreamingFragment(ev: RawEvent): boolean {
  const payload = (ev.payload ?? {}) as Record<string, unknown>;
  switch (ev.agent) {
    case "claude": {
      const event = payload["event"] as Record<string, unknown> | undefined;
      if (payload["type"] === "stream_event") return event?.["type"] === "content_block_delta";
      return payload["type"] === "system" && payload["subtype"] === "thinking_tokens";
    }
    case "codex":
      return typeof payload["method"] === "string" && /(\/delta|Delta)$/.test(payload["method"]);
    // OpenCode sends its text only as chunks, so they stay.
    default:
      return false;
  }
}

/**
 * Native provider output for debugging, kept out of the ledger: newline-delimited JSON under `dir`, one file at a
 * time, rotated by size and pruned by total size and age. The app never reads it back; the ledger holds the
 * normalized events it replays. Lines are redacted exactly as ledger rows are.
 */
export class ProviderLog {
  private stream: WriteStream | null = null;
  private written = 0;
  /** When writing last failed; lines are dropped for a minute after, rather than retrying on every line. */
  private failedAt = -Infinity;
  private readonly maxFileBytes: number;
  private readonly maxTotalBytes: number;
  private readonly maxAgeMs: number;
  private readonly maxRecordBytes: number;
  private readonly maxFileAgeMs: number;
  private openedAt = 0;
  private readonly now: () => number;
  /** Settles once every file rotated out has flushed and been pruned after. */
  private rotatedOut: Promise<void> = Promise.resolve();

  constructor(
    private readonly dir: string,
    options: ProviderLogOptions = {},
  ) {
    this.maxFileBytes = options.maxFileBytes ?? 10 * 1024 * 1024;
    this.maxTotalBytes = options.maxTotalBytes ?? 512 * 1024 * 1024;
    this.maxAgeMs = options.maxAgeMs ?? 14 * DAY_MS;
    this.maxRecordBytes = options.maxRecordBytes ?? 64 * 1024;
    this.maxFileAgeMs = options.maxFileAgeMs ?? DAY_MS;
    this.now = options.now ?? Date.now;
    // Files left from earlier sessions age out even if this one never writes.
    this.prune();
  }

  write(ev: RawEvent): void {
    if (isStreamingFragment(ev) || this.now() - this.failedAt < 60_000) return;
    let line = redactJson({ ts: ev.ts, runId: ev.runId, agent: ev.agent, payload: ev.payload });
    const bytes = Buffer.byteLength(line);
    if (bytes > this.maxRecordBytes) line = JSON.stringify({ ts: ev.ts, runId: ev.runId, agent: ev.agent, truncated: true, bytes, preview: line.slice(0, this.maxRecordBytes) });
    if ((!this.stream || this.written >= this.maxFileBytes || this.now() - this.openedAt >= this.maxFileAgeMs) && !this.rotate()) return;
    this.stream!.write(`${line}\n`);
    this.written += Buffer.byteLength(line) + 1;
  }

  /** Flushes the open file, and waits for files rotated out earlier to flush and be pruned. */
  async close(): Promise<void> {
    const stream = this.stream;
    this.stream = null;
    if (stream) await new Promise<void>((resolve) => stream.end(resolve));
    await this.rotatedOut;
  }

  /** Starts a new file. Returns false, and drops lines for a while, when the folder cannot be written. */
  private rotate(): boolean {
    const previous = this.stream;
    this.stream = null;
    try {
      mkdirSync(this.dir, { recursive: true });
    } catch {
      previous?.end();
      this.failedAt = this.now();
      return false;
    }
    // Sizes on disk are only right once the previous file has flushed, so it is pruned after that.
    if (previous) {
      const flushed = new Promise<void>((resolve) => previous.end(resolve));
      this.rotatedOut = Promise.all([this.rotatedOut, flushed]).then(() => this.prune());
    } else this.prune();
    const stream = createWriteStream(path.join(this.dir, `events-${new Date(this.now()).toISOString().replace(/[:.]/g, "-")}.ndjson`), { flags: "a" });
    // A disk that fills up must not take the core down with it: drop lines for a while, then try a fresh file.
    // Only the current file's failure counts; a late error from one already rotated out changes nothing.
    stream.on("error", () => {
      if (this.stream !== stream) return;
      this.stream = null;
      this.failedAt = this.now();
    });
    this.stream = stream;
    this.written = 0;
    this.openedAt = this.now();
    return true;
  }

  /** Removes files past the age limit, then the oldest until the folder fits its size limit. Never throws into a write. */
  private prune(): void {
    try {
      this.removeExpired();
    } catch {
      // A file removed or locked meanwhile is tried again at the next rotation.
    }
  }

  private removeExpired(): void {
    if (!existsSync(this.dir)) return;
    const files = readdirSync(this.dir)
      .filter((name) => name.startsWith("events-") && name.endsWith(".ndjson"))
      .map((name) => {
        const file = path.join(this.dir, name);
        const stats = statSync(file);
        return { name, file, bytes: stats.size, mtimeMs: stats.mtimeMs };
      })
      // Names carry each file's start time, so they sort oldest first even when writes land in the same instant.
      .sort((a, b) => a.name.localeCompare(b.name));
    let total = files.reduce((sum, file) => sum + file.bytes, 0);
    for (const file of files) {
      if (total <= this.maxTotalBytes && this.now() - file.mtimeMs <= this.maxAgeMs) continue;
      rmSync(file.file, { force: true });
      total -= file.bytes;
    }
  }
}
