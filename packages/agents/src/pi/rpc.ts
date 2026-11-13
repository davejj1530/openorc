import { EventEmitter } from "node:events";
import { z } from "zod";
import type { AgentLaunchEnvironment } from "../launch-environment.js";
import { spawnAgentProcess } from "../process-recovery.js";
import { stopProcess, waitForProcessGroup } from "../process-lifetime.js";

const envelope = z.object({ type: z.string() }).passthrough();
const response = z.object({ type: z.literal("response"), id: z.string().optional(), success: z.boolean(), data: z.unknown().optional(), error: z.string().optional() });
export type PiEvent = z.infer<typeof envelope>;

/** Pi's JSONL protocol is delimited only by LF; Unicode separators belong to message text. */
export class PiRpc extends EventEmitter<{ event: [PiEvent]; failure: [Error] }> {
  private readonly proc;
  private nextId = 0;
  private closed = false;
  private buffer = "";
  private readonly pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  readonly done: Promise<number | null>;

  constructor(launch: AgentLaunchEnvironment, cwd: string, args: string[]) {
    super();
    this.proc = spawnAgentProcess(launch.binary, args, { cwd, env: { ...launch.env }, ...(launch.processRegistry ? { registry: launch.processRegistry } : {}) });
    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (chunk: string) => this.read(chunk));
    this.proc.stderr.resume();
    this.proc.stdin.on("error", (error) => this.fail(error));
    this.proc.on("error", (error) => this.fail(error));
    this.done = new Promise((resolve) => {
      this.proc.once("close", (code) => {
        this.closed = true;
        this.rejectPending(new Error(`Pi exited${code === null ? "" : ` with code ${code}`}.`));
        void waitForProcessGroup(this.proc).then(() => resolve(code));
      });
    });
  }

  request(type: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("Pi is no longer running."));
    const id = String(++this.nextId);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Pi did not answer ${type}.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.notify({ ...params, type, id });
    });
  }

  notify(message: Record<string, unknown>): void {
    if (!this.closed) this.proc.stdin.write(`${JSON.stringify(message)}\n`);
  }

  close(): void {
    this.closed = true;
    this.rejectPending(new Error("Pi was closed."));
    stopProcess(this.proc);
  }

  private rejectPending(error: Error): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.emit("failure", error);
    this.close();
  }

  private read(chunk: string): void {
    this.buffer += chunk;
    let end: number;
    while ((end = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, end).trimEnd();
      this.buffer = this.buffer.slice(end + 1);
      if (!line) continue;
      try {
        const event = envelope.parse(JSON.parse(line));
        if (event.type === "response") {
          const answer = response.parse(event);
          const request = answer.id ? this.pending.get(answer.id) : undefined;
          if (!request) continue;
          this.pending.delete(answer.id!);
          clearTimeout(request.timer);
          if (answer.success) request.resolve(answer.data);
          else request.reject(new Error(answer.error || "Pi rejected the command."));
        } else this.emit("event", event);
      } catch {
        this.fail(new Error("Pi returned invalid RPC data. Update Pi and try again."));
        return;
      }
    }
  }
}
