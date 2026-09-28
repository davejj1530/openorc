import { EventEmitter } from "node:events";
import readline from "node:readline";
import type { ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";

export type JsonRpcId = number | string;

/** CLIs colour their stderr; the ledger and the UI want plain text. */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}

export interface JsonRpcServerRequest {
  id: JsonRpcId;
  method: string;
  params: unknown;
}

export interface JsonRpcNotification {
  method: string;
  params: unknown;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout | undefined;
}

export interface StdioJsonRpcEvents {
  request: [JsonRpcServerRequest];
  notification: [JsonRpcNotification];
  stderr: [string];
  exit: [number | null];
  parseError: [string];
}

/**
 * Newline-delimited JSON-RPC over a child process's stdio. Codex app-server
 * speaks this. It handles three message shapes on the way in: responses to our
 * requests, requests the server makes of us (approvals), and notifications.
 */
export class StdioJsonRpc extends EventEmitter<StdioJsonRpcEvents> {
  private nextId = 1;
  private readonly pending = new Map<JsonRpcId, Pending>();
  private readonly stdin: Writable;
  private terminalError: Error | null = null;

  constructor(
    proc: ChildProcessByStdio<Writable, Readable, Readable>,
    private readonly options: { includeJsonRpcField?: boolean } = {},
  ) {
    super();
    this.stdin = proc.stdin;

    const out = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity });
    out.on("line", (line) => this.handleLine(line));

    const err = readline.createInterface({ input: proc.stderr, crlfDelay: Infinity });
    err.on("line", (line) => this.emit("stderr", stripAnsi(line)));

    // A failed spawn emits error/close without exit. Keep its original error
    // so discovery fails immediately and later requests cannot wait on it.
    proc.on("error", (error) => this.fail(error));
    proc.on("exit", (code) => {
      this.fail(new Error(`process exited with code ${code} before responding`));
      this.emit("exit", code);
    });
  }

  private fail(error: Error): void {
    this.terminalError ??= error;
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(this.terminalError);
    }
    this.pending.clear();
  }

  request<T = unknown>(method: string, params?: unknown, timeoutMs = 60_000): Promise<T> {
    if (this.terminalError) return Promise.reject(this.terminalError);
    const id = this.nextId++;
    const message: Record<string, unknown> = { id, method, params: params ?? {} };
    if (this.options.includeJsonRpcField) message["jsonrpc"] = "2.0";
    return new Promise<T>((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id);
              reject(new Error(`request ${method} timed out after ${timeoutMs} ms`));
            }, timeoutMs)
          : undefined;
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.write(message);
    });
  }

  notify(method: string, params?: unknown): void {
    const message: Record<string, unknown> = { method, params: params ?? {} };
    if (this.options.includeJsonRpcField) message["jsonrpc"] = "2.0";
    this.write(message);
  }

  respond(id: JsonRpcId, result: unknown): void {
    const message: Record<string, unknown> = { id, result };
    if (this.options.includeJsonRpcField) message["jsonrpc"] = "2.0";
    this.write(message);
  }

  respondError(id: JsonRpcId, code: number, message: string): void {
    const payload: Record<string, unknown> = { id, error: { code, message } };
    if (this.options.includeJsonRpcField) payload["jsonrpc"] = "2.0";
    this.write(payload);
  }

  private write(message: Record<string, unknown>): void {
    this.stdin.write(JSON.stringify(message) + "\n");
  }

  private handleLine(line: string): void {
    if (line.trim().length === 0) return;
    let decoded: unknown;
    try {
      decoded = JSON.parse(line);
    } catch {
      this.emit("parseError", line);
      return;
    }
    if (!isRecord(decoded)) {
      this.emit("parseError", line);
      return;
    }
    const msg = decoded;
    const rawId = msg["id"];
    const hasId = typeof rawId === "string" || (typeof rawId === "number" && Number.isFinite(rawId));
    if (rawId !== undefined && rawId !== null && !hasId) {
      this.emit("parseError", line);
      return;
    }
    const method = typeof msg["method"] === "string" ? (msg["method"] as string) : undefined;

    if (hasId && method) {
      this.emit("request", { id: msg["id"] as JsonRpcId, method, params: msg["params"] });
      return;
    }
    if (hasId) {
      const id = msg["id"] as JsonRpcId;
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      if (p.timer) clearTimeout(p.timer);
      if (msg["error"] !== undefined) {
        const error = msg["error"];
        if (!isRecord(error)) p.reject(new Error("invalid rpc error response"));
        else p.reject(new Error(`rpc error ${error["code"] ?? "?"}: ${error["message"] ?? "unknown"}`));
      } else {
        p.resolve(msg["result"]);
      }
      return;
    }
    if (method) {
      this.emit("notification", { method, params: msg["params"] });
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
