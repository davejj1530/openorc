import type { AgentEvent } from "@openorc/protocol";
import { isRecord, num, protocolError, str } from "./stream-values.js";

/**
 * Claude Code's compactions as its stream tells of them: the compacting status, its result, and the boundary with the
 * tokens folded. One the app asked for (`/compact`) is manual. Claude Code may decline one: it says why, announces the
 * session again, repeats why in a synthetic reply and ends with a result, none of which is a turn.
 */
export class ClaudeCompactions {
  /** The compaction in progress, from the compacting status to its boundary. */
  private current: { id: string; manual: boolean } | null = null;
  private count = 0;
  private manualAsked = false;
  /** A manual compaction Claude Code declined, whose lines up to its result are no turn. */
  private declined = false;
  /** A manual compaction ends with an empty result line that is not a turn. */
  private emptyResult = false;

  private readonly runId: string;

  constructor(runId: string) {
    this.runId = runId;
  }

  /** The next compaction was asked for by the app, not started by the CLI on its own. */
  expectManual(): void {
    this.manualAsked = true;
  }

  /** Whether a session announcement is a compaction's, not a turn's start. */
  quiet(): boolean {
    return this.current !== null || this.declined;
  }

  /** Whether an assistant line is a declined compaction's synthetic reply. */
  declinedReply(msg: Record<string, unknown>): boolean {
    return this.declined && isRecord(msg["message"]) && msg["message"]["model"] === "<synthetic>";
  }

  /** Whether a result line is a manual compaction's own, which ends no turn. */
  ownsResult(modelTurns: number): boolean {
    if (this.declined) {
      this.declined = false;
      return true;
    }
    if (!this.emptyResult) return false;
    this.emptyResult = false;
    return modelTurns === 0;
  }

  /** A status line that tells of a compaction: it begins, or ends with a result. */
  status(msg: Record<string, unknown>, now: number, out: AgentEvent[]): void {
    if (msg["status"] === "compacting") {
      if (this.current) return;
      this.current = { id: `compaction-${++this.count}`, manual: this.manualAsked };
      this.manualAsked = false;
      out.push({ ...this.activity(now, "running"), detail: { mode: this.current.manual ? "manual" : "automatic" } });
      return;
    }
    if (msg["compact_result"] === undefined || !this.current) return;
    const result = str(msg["compact_result"]);
    if (result === "success") {
      if (this.current.manual) this.emptyResult = true;
      return;
    }
    // Claude Code says why in `compact_error`, as "Not enough messages to compact." for a conversation already folded.
    out.push({ ...this.activity(now, "error"), text: str(msg["compact_error"]) ?? str(msg["error"]) ?? `Compaction ${result ?? "failed"}.` });
    this.declined = this.current.manual;
    this.current = null;
  }

  /** The boundary a compaction leaves: the context it folded to, and the compaction done. */
  boundary(msg: Record<string, unknown>, now: number, out: AgentEvent[]): void {
    const rawMeta = msg["compact_metadata"];
    if (rawMeta !== undefined && !isRecord(rawMeta)) {
      out.push(protocolError(this.runId, now, "Expected compact_metadata to be an object"));
      return;
    }
    const meta = rawMeta as Record<string, unknown> | undefined;
    const pre = num(meta?.["pre_tokens"]);
    const post = num(meta?.["post_tokens"]);
    if (post !== undefined) out.push({ type: "context.updated", runId: this.runId, ts: now, contextTokens: post });
    const text = pre !== undefined && post !== undefined ? `${pre.toLocaleString()} tokens folded into ${post.toLocaleString()}.` : undefined;
    const manual = str(meta?.["trigger"]) === "manual" || this.current?.manual;
    const id = this.current?.id ?? `compaction-${++this.count}`;
    out.push({ ...this.activity(now, "success", id), ...(text ? { text } : {}), detail: { mode: manual ? "manual" : "automatic" } });
    this.current = null;
  }

  private activity(now: number, status: "running" | "success" | "error", id = this.current!.id): Extract<AgentEvent, { type: "activity.updated" }> {
    return { type: "activity.updated", runId: this.runId, ts: now, activityId: id, label: "Compacting context", status };
  }
}
