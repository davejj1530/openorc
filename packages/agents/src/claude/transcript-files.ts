import { watch, type FSWatcher } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { AgentEvent } from "@openorc/protocol";
import type { ClaudeStreamParser, ClaudeTranscriptTarget } from "./stream-json.js";
import { isRecord } from "./stream-values.js";

const safeId = (value: string): boolean => /^[a-zA-Z0-9_-]+$/.test(value);
const exists = async (file: string): Promise<boolean> =>
  stat(file).then(
    () => true,
    () => false,
  );

/** Byte offsets retain partial UTF-8 and partial JSON lines without re-reading the transcript. */
class TranscriptCursor {
  private offset = 0;
  private inode: number | null = null;
  private partial = Buffer.alloc(0);
  private readonly seen = new Set<string>();

  async read(file: string, receive: (message: Record<string, unknown>) => void): Promise<void> {
    const handle = await open(file, "r");
    try {
      const info = await handle.stat();
      if (info.size < this.offset || (this.inode !== null && this.inode !== info.ino)) {
        this.offset = 0;
        this.partial = Buffer.alloc(0);
      }
      this.inode = info.ino;
      const buffer = Buffer.alloc(64 * 1024);
      while (this.offset < info.size) {
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, info.size - this.offset), this.offset);
        if (!bytesRead) break;
        this.offset += bytesRead;
        this.consume(buffer.subarray(0, bytesRead), receive);
      }
    } finally {
      await handle.close();
    }
  }

  private consume(bytes: Buffer, receive: (message: Record<string, unknown>) => void): void {
    const data = Buffer.concat([this.partial, bytes]);
    let start = 0;
    for (let end = data.indexOf(10); end !== -1; end = data.indexOf(10, start)) {
      const line = data.subarray(start, end).toString("utf8");
      start = end + 1;
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isRecord(message) || typeof message["uuid"] !== "string" || this.seen.has(message["uuid"])) continue;
      this.seen.add(message["uuid"]);
      receive(message);
    }
    this.partial = Buffer.from(data.subarray(start));
  }
}

interface Source {
  cursor: TranscriptCursor;
  file?: string;
  endsAt?: number;
}

/** One local session watcher, with polling for late files and missed filesystem notifications. */
export class ClaudeTranscriptFiles {
  private readonly sources = new Map<string, Source>();
  private folder: string | null = null;
  private watcher: FSWatcher | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private reading: Promise<void> | null = null;
  private dirty = false;
  private closed = false;
  private closing: Promise<void> | null = null;
  private targetsKey = "";

  constructor(
    private readonly parser: ClaudeStreamParser,
    private readonly configDir: string,
    private readonly emit: (event: AgentEvent) => void,
    private readonly pollMs = 500,
  ) {}

  sync(): void {
    if (this.closed) return;
    const active = this.parser.transcriptTargets().some((target) => !target.finished || (this.sources.get(target.agentId)?.endsAt ?? Infinity) >= Date.now());
    if (!active) return;
    if (!this.timer) {
      this.timer = setInterval(() => void this.drain(), this.pollMs);
      this.timer.unref();
    }
    const key = JSON.stringify(this.parser.transcriptTargets());
    if (key !== this.targetsKey) {
      this.targetsKey = key;
      void this.drain();
    }
  }

  drain(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.dirty = true;
    if (this.reading) return this.reading;
    this.reading = this.readPending().finally(() => {
      this.reading = null;
    });
    return this.reading;
  }

  private async readPending(): Promise<void> {
    while (this.dirty && !this.closed) {
      this.dirty = false;
      await this.read(false);
    }
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.stopWatching();
    this.closing = (async () => {
      await this.reading;
      await this.read(true);
    })();
    return this.closing;
  }

  private async read(final: boolean): Promise<void> {
    const targets = this.parser.transcriptTargets();
    if (!targets.length) return;
    this.folder ??= await this.locateSession();
    if (this.folder && !this.closed) this.watchFolder(this.folder);
    let live = false;
    for (const target of targets) {
      if (!safeId(target.agentId)) continue;
      const source = this.sources.get(target.agentId) ?? { cursor: new TranscriptCursor() };
      this.sources.set(target.agentId, source);
      if (target.finished) source.endsAt ??= Date.now() + this.pollMs * 2;
      else source.endsAt = undefined;
      const active = source.endsAt === undefined || Date.now() <= source.endsAt;
      live ||= active;
      if (!active && !final) continue;
      if (this.folder) await this.readSource(target, source);
    }
    if (!live) this.stopWatching();
  }

  private async locateSession(): Promise<string | null> {
    const id = this.parser.workflows.sessionId;
    if (!id || !safeId(id)) return null;
    const projects = path.join(this.configDir, "projects");
    const folders = await readdir(projects, { withFileTypes: true }).catch(() => []);
    for (const folder of folders) {
      if (!folder.isDirectory()) continue;
      const session = path.join(projects, folder.name, id);
      if ((await exists(session)) || (await exists(`${session}.jsonl`))) return path.join(session, "subagents");
    }
    return null;
  }

  private watchFolder(folder: string): void {
    if (this.watcher) return;
    try {
      this.watcher = watch(folder, { recursive: true, persistent: false }, () => void this.drain());
      this.watcher.on("error", () => {
        this.watcher?.close();
        this.watcher = null;
      });
    } catch {
      /* The directory can appear after the first progress event. The poll retries. */
    }
  }

  private async readSource(target: ClaudeTranscriptTarget, source: Source): Promise<void> {
    source.file ??= await this.locateAgent(target);
    if (!source.file) return;
    try {
      await source.cursor.read(source.file, (message) => {
        const parsed = typeof message["timestamp"] === "string" ? Date.parse(message["timestamp"]) : NaN;
        const ts = Number.isFinite(parsed) ? parsed : Date.now();
        for (const event of this.parser.transcriptMessage(target, message, ts)) {
          try {
            this.emit(event);
          } catch {
            /* A subscriber must not discard later records in this chunk. */
          }
        }
      });
    } catch (error) {
      // A rename during append is retried through discovery; lifecycle still comes from the stream.
      if (isRecord(error) && error["code"] === "ENOENT") source.file = undefined;
    }
  }

  private async locateAgent(target: ClaudeTranscriptTarget): Promise<string | undefined> {
    if (!this.folder) return undefined;
    const name = `agent-${target.agentId}.jsonl`;
    if (target.kind === "agent") {
      const file = path.join(this.folder, name);
      return (await exists(file)) ? file : undefined;
    }
    const folder = path.join(this.folder, "workflows");
    const workflows = await readdir(folder, { withFileTypes: true }).catch(() => []);
    for (const workflow of workflows) {
      if (!workflow.isDirectory()) continue;
      const file = path.join(folder, workflow.name, name);
      if (await exists(file)) return file;
    }
    return undefined;
  }

  private stopWatching(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.watcher?.close();
    this.watcher = null;
  }
}
