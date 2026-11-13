import type { SessionUpdate } from "@agentclientprotocol/sdk";
import type { BackgroundCommand, RunStatus } from "@openorc/protocol";
import type { AgentCommand, JobReport, OwnTurns, SessionEntry } from "../acp/profile.js";

/** Pages of messages read back looking for the last one reported; OpenCode lists 50 to a page, newest first. */
const PAGES = 4;
const DESCRIPTION_MAX = 200;

const record = (value: unknown): Record<string, unknown> => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

function outcomeOf(outcome: unknown): RunStatus {
  if (outcome === "succeeded") return "success";
  return typeof outcome === "string" && /interrupt|abort|cancel/.test(outcome) ? "cancelled" : "error";
}

function jobOf(metadata: Record<string, unknown>): JobReport | undefined {
  const id = text(metadata["jobID"]) ?? text(metadata["shellID"]);
  if (metadata["source"] !== "shell" || !id) return undefined;
  const state = metadata["state"] === "cancelled" || metadata["state"] === "error" ? metadata["state"] : "completed";
  const exit = metadata["exit"];
  return { id, state, ...(typeof exit === "number" ? { exit } : {}) };
}

function contentText(content: unknown): string {
  return (Array.isArray(content) ? content : [])
    .map(record)
    .flatMap((part) => (part["type"] === "text" && typeof part["text"] === "string" ? [part["text"]] : []))
    .join("");
}

/** A tool part as the ACP server streams it: the call, then its end once it has one. */
function toolUpdates(part: Record<string, unknown>): SessionUpdate[] {
  const toolCallId = text(part["id"]);
  const name = text(part["name"]) ?? "tool";
  if (!toolCallId) return [];
  const state = record(part["state"]);
  const status = state["status"];
  const call = { sessionUpdate: "tool_call", toolCallId, name, title: name, rawInput: status === "streaming" ? {} : (state["input"] ?? {}), status: "pending" } as SessionUpdate;
  if (status === "completed") return [call, { sessionUpdate: "tool_call_update", toolCallId, status: "completed", rawOutput: { output: contentText(state["content"]) } }];
  if (status === "error") return [call, { sessionUpdate: "tool_call_update", toolCallId, status: "failed", rawOutput: { error: text(record(state["error"])["message"]) ?? "The tool failed." } }];
  return [call];
}

/** An assistant message's parts in order: its words, its reasoning and its tool calls. */
function assistantUpdates(id: string, content: unknown): SessionUpdate[] {
  const parts = (Array.isArray(content) ? content : []).map(record);
  let texts = 0;
  let thoughts = 0;
  return parts.flatMap((part): SessionUpdate[] => {
    if (part["type"] === "text" && typeof part["text"] === "string") {
      const messageId = texts++ ? `${id}:${texts - 1}` : id;
      return [{ sessionUpdate: "agent_message_chunk", messageId, content: { type: "text", text: part["text"] } }];
    }
    if (part["type"] === "reasoning" && typeof part["text"] === "string")
      return [{ sessionUpdate: "agent_thought_chunk", messageId: `${id}:reasoning:${thoughts++}`, content: { type: "text", text: part["text"] } }];
    if (part["type"] === "tool") return toolUpdates(part);
    return [];
  });
}

function entryOf(value: unknown): SessionEntry[] {
  const message = record(value);
  const id = text(message["id"]);
  if (!id) return [];
  switch (message["type"]) {
    case "idle":
      return [{ id, kind: "idle", outcome: outcomeOf(message["outcome"]) }];
    case "user":
      return [{ id, kind: "user", text: text(message["text"]) ?? "" }];
    case "assistant":
      return [{ id, kind: "assistant", updates: assistantUpdates(id, message["content"]) }];
    default: {
      const job = jobOf(record(message["metadata"]));
      return [{ id, kind: "other", ...(job ? { job } : {}) }];
    }
  }
}

/**
 * OpenCode's turns of its own, read through `opencode api`: a private server over the same session store, so it sees
 * what the ACP server's own server wrote. A shell command OpenCode moved to the background reports back into the session
 * when it ends, and that report starts a turn.
 */
export const openCodeOwnTurns: OwnTurns = {
  async read(run: AgentCommand, sessionId: string, since: string | null): Promise<SessionEntry[]> {
    if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) throw new Error("OpenCode named a session OpenOrc cannot read.");
    const newestFirst: unknown[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < PAGES; page++) {
      const answer = record(JSON.parse(await run(["api", "--standalone", "GET", `/api/session/${sessionId}/message`, ...(cursor ? ["--param", `cursor=${cursor}`] : [])])));
      const data = answer["data"];
      if (!Array.isArray(data)) throw new Error("OpenCode did not list the session's messages.");
      newestFirst.push(...data);
      cursor = text(record(answer["cursor"])["next"]);
      if (!since || !cursor || !data.length || data.some((message) => record(message)["id"] === since)) break;
    }
    return newestFirst.reverse().flatMap(entryOf);
  },
  startedJob({ name, input, output }): BackgroundCommand | null {
    if (name !== "shell" || typeof output !== "string" || !/notified automatically/.test(output)) return null;
    const id = /shell ID: ([A-Za-z0-9_-]+)\)/.exec(output)?.[1];
    if (!id) return null;
    const args = record(input);
    const description = (text(args["description"]) ?? text(args["command"]) ?? "Background command").split("\n")[0]!.trim();
    return { id, description: description.length > DESCRIPTION_MAX ? `${description.slice(0, DESCRIPTION_MAX - 1)}…` : description };
  },
};
