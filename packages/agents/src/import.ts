import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import type { AgentEvent, AgentKind } from "@openorc/protocol";

/** A CLI's own session file, found on disk, before it is read in full. */
export interface SessionFile {
  agent: AgentKind;
  path: string;
  sessionId: string;
  cwd: string | null;
  title: string;
  messages: number;
  startedAt: number;
  endedAt: number;
}

/** A session read in full: what happened, as our events, ready for the ledger. */
export interface ImportedSession extends SessionFile {
  events: AgentEvent[];
  lastReply: string | null;
}

const clipTitle = (text: string) => {
  const line =
    text
      .split("\n")
      .find((l) => l.trim().length > 0)
      ?.trim() ?? "Imported session";
  return line.length > 72 ? `${line.slice(0, 71).trimEnd()}…` : line;
};

async function* lines(file: string): AsyncGenerator<Record<string, unknown>> {
  const rl = readline.createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isRecord(parsed)) yield parsed;
    } catch {
      // A torn line while the CLI is still writing is not a session event.
    }
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const when = (v: unknown, fallback: number): number => {
  let t = NaN;
  if (typeof v === "string") t = Date.parse(v);
  else if (typeof v === "number") t = v;
  return Number.isFinite(t) ? t : fallback;
};

/* Claude Code: ~/.claude/projects/<cwd with every other character as ->/<session>.jsonl */

export function claudeProjectDir(cwd: string, home = os.homedir()): string {
  return path.join(home, ".claude", "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));
}

/** Text a user line carries that the user did not type: slash-command echoes and injected context. */
function isInjected(text: string): boolean {
  return /^\s*<(command-name|local-command|system-reminder|user-prompt-submit-hook|ide_|task-notification)/.test(text) || (/^\s*<[a-z_-]+>[\s\S]*<\/[a-z_-]+>\s*$/.test(text) && text.length > 400);
}

function claudeUserText(message: Record<string, unknown> | null): string | null {
  const content = message?.["content"];
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const text = content
    .filter(isRecord)
    .filter((b) => b["type"] === "text" && typeof b["text"] === "string")
    .map((b) => b["text"] as string)
    .join("\n");
  return text || null;
}

/** A caller's memory of files it has read: a file, null for one that was not a session, undefined to read it. */
export type SessionCache = (file: string) => Promise<SessionFile | null | undefined>;

export async function listClaudeSessions(cwd: string, home = os.homedir(), cache?: SessionCache): Promise<SessionFile[]> {
  const dir = claudeProjectDir(cwd, home);
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith(".jsonl"));
  } catch {
    return [];
  }
  const out: SessionFile[] = [];
  for (const name of names) {
    const file = path.join(dir, name);
    const hit = cache ? await cache(file) : undefined;
    const meta = hit === undefined ? await claudeMeta(file, cwd) : hit;
    if (meta) out.push(meta);
  }
  return out.sort((a, b) => b.startedAt - a.startedAt);
}

async function claudeMeta(file: string, cwd: string): Promise<SessionFile | null> {
  const s = await stat(file);
  let sessionId: string | null = null;
  let title: string | null = null;
  let messages = 0;
  let startedAt = s.birthtimeMs;
  let endedAt = s.mtimeMs;
  let sawCwd: string | null = null;
  for await (const row of lines(file)) {
    const type = row["type"];
    if (type !== "user" && type !== "assistant") continue;
    if (row["isSidechain"] === true || row["isMeta"] === true) continue;
    sessionId ??= str(row["sessionId"]);
    sawCwd ??= str(row["cwd"]);
    const ts = when(row["timestamp"], endedAt);
    if (messages === 0) startedAt = ts;
    endedAt = ts;
    if (type === "user") {
      const text = claudeUserText(isRecord(row["message"]) ? row["message"] : null);
      if (!text || isInjected(text)) continue;
      title ??= clipTitle(text);
      messages += 1;
    } else messages += 1;
  }
  if (!sessionId || messages === 0 || !title) return null;
  if (sawCwd && path.resolve(sawCwd) !== path.resolve(cwd)) return null;
  return { agent: "claude", path: file, sessionId, cwd: sawCwd, title, messages, startedAt, endedAt };
}

export async function readClaudeSession(file: string, runId: string, cwd: string): Promise<ImportedSession | null> {
  const meta = await claudeMeta(file, cwd);
  if (!meta) return null;
  const events: AgentEvent[] = [];
  const toolNames = new Map<string, string>();
  let lastReply: string | null = null;
  let first = true;
  for await (const row of lines(file)) {
    const type = row["type"];
    if (type !== "user" && type !== "assistant") continue;
    if (row["isSidechain"] === true || row["isMeta"] === true) continue;
    const ts = when(row["timestamp"], meta.endedAt);
    if (first) {
      events.push({ type: "session.started", runId, ts, agent: "claude", externalSessionId: meta.sessionId, model: null });
      first = false;
    }
    const message = isRecord(row["message"]) ? row["message"] : null;
    const content = Array.isArray(message?.["content"]) ? message["content"].filter(isRecord) : [];
    if (type === "user") {
      const text = claudeUserText(message);
      if (text && !isInjected(text)) events.push({ type: "message.completed", runId, ts, messageId: str(row["uuid"]) ?? `user-${ts}`, role: "user", text });
      for (const b of content) {
        if (b["type"] === "tool_result" && typeof b["tool_use_id"] === "string") {
          events.push({ type: "tool.completed", runId, ts, toolCallId: b["tool_use_id"], name: toolNames.get(b["tool_use_id"]) ?? "tool", output: b["content"], isError: b["is_error"] === true });
        }
      }
      continue;
    }
    const messageId = str(message?.["id"]) ?? str(row["uuid"]) ?? `assistant-${ts}`;
    const text = content
      .filter((b) => b["type"] === "text" && typeof b["text"] === "string")
      .map((b) => b["text"] as string)
      .join("");
    if (text.trim()) {
      events.push({ type: "message.completed", runId, ts, messageId, role: "assistant", text });
      lastReply = text;
    }
    for (const b of content) {
      if (b["type"] === "tool_use" && typeof b["id"] === "string" && typeof b["name"] === "string") {
        toolNames.set(b["id"], b["name"]);
        events.push({ type: "tool.started", runId, ts, toolCallId: b["id"], name: b["name"], input: b["input"], parentToolCallId: null });
      }
    }
  }
  events.push({
    type: "turn.completed",
    runId,
    ts: meta.endedAt,
    turnId: "imported",
    status: "success",
    ...(lastReply ? { resultText: lastReply } : {}),
    durationMs: Math.max(0, meta.endedAt - meta.startedAt),
  });
  events.push({ type: "session.completed", runId, ts: meta.endedAt, status: "success", durationMs: Math.max(0, meta.endedAt - meta.startedAt) });
  return { ...meta, events, lastReply };
}

/* Codex: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl, the cwd in the first line's session_meta */

export function codexSessionsDir(home = os.homedir()): string {
  return path.join(home, ".codex", "sessions");
}

async function walk(dir: string, depth: number): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of entries) {
    const p = path.join(dir, name);
    if (name.endsWith(".jsonl")) out.push(p);
    else if (depth > 0 && !name.includes(".")) out.push(...(await walk(p, depth - 1)));
  }
  return out;
}

function codexText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter(isRecord)
    .filter((c) => (c["type"] === "input_text" || c["type"] === "output_text") && typeof c["text"] === "string")
    .map((c) => c["text"] as string)
    .join("\n");
}

export async function listCodexSessions(cwd: string, home = os.homedir(), cache?: SessionCache): Promise<SessionFile[]> {
  const files = await walk(codexSessionsDir(home), 3);
  const out: SessionFile[] = [];
  for (const file of files) {
    const hit = cache ? await cache(file) : undefined;
    const meta = hit === undefined ? await codexMeta(file, cwd) : hit;
    if (meta) out.push(meta);
  }
  return out.sort((a, b) => b.startedAt - a.startedAt);
}

async function codexMeta(file: string, cwd: string): Promise<SessionFile | null> {
  const s = await stat(file);
  let sessionId: string | null = null;
  let sawCwd: string | null = null;
  let title: string | null = null;
  let messages = 0;
  let startedAt = s.birthtimeMs;
  let endedAt = s.mtimeMs;
  for await (const row of lines(file)) {
    const payload = isRecord(row["payload"]) ? row["payload"] : null;
    if (row["type"] === "session_meta" && payload) {
      sessionId = str(payload["id"]) ?? str(payload["session_id"]);
      sawCwd = str(payload["cwd"]);
      startedAt = when(payload["timestamp"] ?? row["timestamp"], startedAt);
      // The wrong project: stop reading before the transcript.
      if (sawCwd && path.resolve(sawCwd) !== path.resolve(cwd)) return null;
      continue;
    }
    if (row["type"] !== "response_item" || payload?.["type"] !== "message") continue;
    const role = payload["role"];
    const text = codexText(payload["content"]);
    if (role === "user") {
      if (!text.trim() || text.trimStart().startsWith("<")) continue;
      title ??= clipTitle(text);
      messages += 1;
    } else if (role === "assistant" && text.trim()) messages += 1;
    endedAt = when(row["timestamp"], endedAt);
  }
  if (!sessionId || !sawCwd || messages === 0 || !title) return null;
  return { agent: "codex", path: file, sessionId, cwd: sawCwd, title, messages, startedAt, endedAt };
}

export async function readCodexSession(file: string, runId: string, cwd: string): Promise<ImportedSession | null> {
  const meta = await codexMeta(file, cwd);
  if (!meta) return null;
  const events: AgentEvent[] = [{ type: "session.started", runId, ts: meta.startedAt, agent: "codex", externalSessionId: meta.sessionId, model: null }];
  const callNames = new Map<string, string>();
  let lastReply: string | null = null;
  let n = 0;
  for await (const row of lines(file)) {
    if (row["type"] !== "response_item") continue;
    const payload = isRecord(row["payload"]) ? row["payload"] : null;
    if (!payload) continue;
    const ts = when(row["timestamp"], meta.endedAt);
    n += 1;
    const id = str(payload["id"]) ?? `codex-${n}`;
    switch (payload["type"]) {
      case "message": {
        const role = payload["role"];
        const text = codexText(payload["content"]);
        if (!text.trim()) break;
        if (role === "user" && !text.trimStart().startsWith("<")) events.push({ type: "message.completed", runId, ts, messageId: id, role: "user", text });
        else if (role === "assistant") {
          events.push({ type: "message.completed", runId, ts, messageId: id, role: "assistant", text });
          lastReply = text;
        }
        break;
      }
      case "reasoning": {
        const summary = Array.isArray(payload["summary"])
          ? payload["summary"]
              .filter(isRecord)
              .map((x) => str(x["text"]) ?? "")
              .join("\n\n")
          : "";
        if (summary.trim()) events.push({ type: "thinking.delta", runId, ts, messageId: id, text: summary });
        break;
      }
      case "function_call": {
        const callId = str(payload["call_id"]) ?? id;
        const name = str(payload["name"]) ?? "tool";
        let input: unknown = payload["arguments"];
        try {
          input = typeof input === "string" ? JSON.parse(input) : input;
        } catch {
          // keep the raw string
        }
        callNames.set(callId, name);
        events.push({ type: "tool.started", runId, ts, toolCallId: callId, name, input, parentToolCallId: null });
        break;
      }
      case "function_call_output": {
        const callId = str(payload["call_id"]) ?? id;
        events.push({ type: "tool.completed", runId, ts, toolCallId: callId, name: callNames.get(callId) ?? "tool", output: payload["output"], isError: false });
        break;
      }
      default:
        break;
    }
  }
  events.push({
    type: "turn.completed",
    runId,
    ts: meta.endedAt,
    turnId: "imported",
    status: "success",
    ...(lastReply ? { resultText: lastReply } : {}),
    durationMs: Math.max(0, meta.endedAt - meta.startedAt),
  });
  events.push({ type: "session.completed", runId, ts: meta.endedAt, status: "success", durationMs: Math.max(0, meta.endedAt - meta.startedAt) });
  return { ...meta, events, lastReply };
}
