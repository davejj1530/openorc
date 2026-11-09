import type { SessionUpdate } from "@agentclientprotocol/sdk";
import type { BackgroundCommand } from "@openorc/protocol";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { JobReport, OwnTurns, SessionEntry } from "../acp/profile.js";

const DESCRIPTION_MAX = 200;

const record = (value: unknown): Record<string, unknown> => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

/** Where Antigravity keeps a conversation's steps, one JSON object per line. */
export const antigravityTranscript = (env: NodeJS.ProcessEnv, sessionId: string): string =>
  path.join(env["HOME"] || os.homedir(), ".gemini", "antigravity-cli", "brain", sessionId, ".system_generated", "logs", "transcript_full.jsonl");

function steps(raw: string): Record<string, unknown>[] {
  return raw.split("\n").flatMap((line) => {
    if (!line.trim()) return [];
    try {
      return [record(JSON.parse(line))];
    } catch {
      // A step still being written.
      return [];
    }
  });
}

/** A finished background task's report: "Task id "<id>" finished with result: … Command output: …". */
function reportOf(content: string, commands: Map<string, string>): JobReport | undefined {
  const finished = /Task id "([^"]+)" finished with result:/.exec(content);
  if (!finished) return undefined;
  const id = finished[1]!;
  const exit = /Command exited with code (-?\d+)/.exec(content)?.[1];
  const output = /Command output:\n([\s\S]*?)(?:\n\nLog:|\n<\/SYSTEM_MESSAGE>|$)/.exec(content)?.[1]?.replace(/\r/g, "").trimEnd();
  const command = commands.get(id);
  return { id, state: "completed", ...(exit !== undefined ? { exit: Number(exit) } : {}), ...(output !== undefined ? { output } : {}), ...(command ? { command } : {}) };
}

/** A model step: its thought, its words and its calls; one with no calls ends its turn. */
function modelStep(id: string, step: Record<string, unknown>, content: string, calls: string[]): SessionEntry[] {
  const updates: SessionUpdate[] = [];
  const thinking = text(step["thinking"]);
  if (thinking) updates.push({ sessionUpdate: "agent_thought_chunk", messageId: `${id}:thought`, content: { type: "text", text: thinking } });
  if (content) updates.push({ sessionUpdate: "agent_message_chunk", messageId: id, content: { type: "text", text: content } });
  const toolCalls = Array.isArray(step["tool_calls"]) ? step["tool_calls"].map(record) : [];
  toolCalls.forEach((call, index) => {
    const toolCallId = `${id}:tool-${index}`;
    const name = text(call["name"]) ?? "tool";
    calls.push(toolCallId);
    updates.push({ sessionUpdate: "tool_call", toolCallId, name, title: name, rawInput: call["args"] ?? {}, status: "pending" } as SessionUpdate);
  });
  const done = step["status"] === "DONE" && toolCalls.length === 0;
  return [{ id, kind: "assistant", updates }, ...(done ? [{ id: `${id}:end`, kind: "idle", outcome: "success" } as const] : [])];
}

/** A tool's result, answering the oldest call still waiting; one that went to the background stays open. */
function resultStep(id: string, step: Record<string, unknown>, content: string, calls: string[], commands: Map<string, string>): SessionEntry[] {
  const toolCallId = calls.shift();
  const task = /running as a background task with task id: (\S+)/.exec(content);
  if (task) {
    const description = /Task Description: (.*)/.exec(content)?.[1];
    if (description) commands.set(task[1]!, description.trim());
    return [{ id, kind: "other" }];
  }
  if (!toolCallId || step["status"] === "RUNNING") return [{ id, kind: "other" }];
  const failed = step["status"] === "ERROR";
  const update = {
    sessionUpdate: "tool_call_update",
    toolCallId,
    status: failed ? "failed" : "completed",
    rawOutput: failed ? { error: text(step["error"]) ?? content } : { output: content },
  } as SessionUpdate;
  return [{ id, kind: "assistant", updates: [update] }];
}

/**
 * The steps as session entries. A model step's tool calls are answered by the steps after it, in order; a model step
 * with no calls ends its turn, since Antigravity writes no marker of its own there.
 */
function entriesOf(all: Record<string, unknown>[]): SessionEntry[] {
  const calls: string[] = [];
  const commands = new Map<string, string>();
  return all.flatMap((step): SessionEntry[] => {
    const id = `step-${String(step["step_index"])}`;
    const content = text(step["content"]) ?? "";
    switch (step["type"]) {
      case "USER_INPUT":
        return [{ id, kind: "user", text: content.replace(/^<USER_REQUEST>\n?|\n?<\/USER_REQUEST>$/g, "") }];
      case "PLANNER_RESPONSE":
        return modelStep(id, step, content, calls);
      case "GENERIC":
        return resultStep(id, step, content, calls, commands);
      case "SYSTEM_MESSAGE": {
        const job = reportOf(content, commands);
        return [{ id, kind: "other", ...(job ? { job } : {}) }];
      }
      default:
        return [{ id, kind: "other" }];
    }
  });
}

/**
 * Antigravity's turns of its own, read from the transcript it keeps for each conversation on this Mac. A command it
 * runs as a background task leaves its call open, and the task's end reaches the agent as a message that starts a turn.
 */
export const antigravityOwnTurns: OwnTurns = {
  async read(_run, sessionId, _since, env): Promise<SessionEntry[]> {
    if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) throw new Error("Antigravity named a conversation OpenOrc cannot read.");
    let raw: string;
    try {
      raw = await readFile(antigravityTranscript(env, sessionId), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    return entriesOf(steps(raw));
  },
  leftRunning({ id, name, input }): BackgroundCommand | null {
    if (name !== "run_command") return null;
    const command = text(record(input)["CommandLine"])?.split("\n")[0]?.trim();
    if (!command) return null;
    return { id, description: command.length > DESCRIPTION_MAX ? `${command.slice(0, DESCRIPTION_MAX - 1)}…` : command };
  },
};
