import type { SessionUpdate } from "@agentclientprotocol/sdk";
import type { AgentEvent, SubagentStatus } from "@openorc/protocol";
import { AcpUpdateMapper } from "./updates.js";

type Child = { mapper: AcpUpdateMapper; status: SubagentStatus; statusObserved: boolean };
const statuses: Record<string, SubagentStatus | undefined> = { running: "running", completed: "completed", failed: "failed", interrupted: "stopped", no_updates: "no_updates" };
type Launch = { id: string; parent: string; input: Record<string, unknown>; linked: boolean; ended: boolean };
type ChildUpdate = {
  rootSessionId: string;
  childSessionId: string;
  parentSessionId: string;
  title: string;
  type: "status" | "update";
  status?: string;
  error?: string;
  update?: SessionUpdate;
};

const record = (value: unknown): Record<string, unknown> => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const string = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

/** The extension envelope surrounds the same SessionUpdate that ACP normally delivers. */
export function childUpdate(value: unknown): ChildUpdate {
  const frame = record(value);
  if (![frame["rootSessionId"], frame["childSessionId"], frame["parentSessionId"], frame["title"]].every((v) => typeof v === "string") || !["status", "update"].includes(String(frame["type"])))
    throw new Error("Invalid OpenCode child update");
  if (frame["type"] === "update" && typeof record(frame["update"])["sessionUpdate"] !== "string") throw new Error("Invalid OpenCode session update");
  return frame as ChildUpdate;
}

/** One mapper per native child; parent prompts can end while these sessions keep streaming. */
export class AcpSubagents {
  private readonly children = new Map<string, Child>();
  private readonly launches = new Map<string, Launch>();
  private readonly dropped = new Set<string>();

  constructor(
    private readonly runId: string,
    private readonly root: () => string | null,
    private readonly emit: (event: AgentEvent) => void,
    private readonly onDrop: (id: string) => void = () => {},
  ) {}

  canStop(id: string): boolean {
    return this.children.get(id)?.status === "running";
  }

  /** False denies a dropped session; undefined is the parent, otherwise its native child id. */
  permissionSession(id: string): string | undefined | false {
    if (this.dropped.has(id)) return false;
    return id === this.root() ? undefined : id;
  }

  route(frame: ChildUpdate, ts: number): void {
    if (frame.rootSessionId !== this.root()) return;
    if (!this.register(frame.childSessionId, frame.parentSessionId, frame.title, ts)) return;
    if (frame.type === "update" && frame.update) this.map(frame.childSessionId, frame.update, ts);
    else if (frame.status) {
      this.children.get(frame.childSessionId)!.statusObserved = true;
      this.status(frame.childSessionId, frame.status, ts, string(frame.error) ?? string(record(frame.error)["message"]));
    }
  }

  /** Older OpenCode versions put child metadata on an ordinary parent notification. */
  legacy(update: SessionUpdate, ts: number): boolean {
    const child = record(update._meta?.["opencode/child-session"]);
    const id = string(child["id"]);
    if (!id) return false;
    if (this.register(id, string(child["parentID"]) ?? this.root()!, string(child["title"]) ?? "Subagent", ts)) this.map(id, update, ts);
    return true;
  }

  observe(parent: string, update: SessionUpdate, ts: number): void {
    if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") return;
    const key = `${parent}:${update.toolCallId}`;
    const input = record(update.rawInput);
    let launch = this.launches.get(key);
    if (!launch && (update.name === "subagent" || update.title === "subagent" || typeof input["agent"] === "string")) {
      launch = { id: update.toolCallId, parent, input, linked: false, ended: false };
      this.launches.set(key, launch);
    }
    if (!launch) return;
    if (update.rawInput) launch.input = input;
    if (update.status === "completed" || update.status === "failed") {
      launch.ended = true;
      this.toolResult(update, ts);
    }
  }

  private toolResult(update: Extract<SessionUpdate, { sessionUpdate: "tool_call" | "tool_call_update" }>, ts: number): void {
    const output = record(update.rawOutput),
      metadata = record(output["metadata"]);
    const id = string(metadata["sessionID"]);
    const child = id ? this.children.get(id) : undefined;
    if (!id || !child || child.statusObserved || child.status !== "running") return;
    const error = string(output["error"]);
    let status = string(metadata["status"]);
    if (update.status === "failed") status = error && /cancelled|canceled|interrupted/i.test(error) ? "interrupted" : "failed";
    if (status && status !== "running") this.status(id, status, ts, error);
  }

  cancelled(id: string, ts: number): void {
    const child = this.children.get(id);
    if (child && !child.statusObserved) this.status(id, "interrupted", ts);
  }

  endParentTurn(ts: number): void {
    for (const [id, child] of this.children) if (!child.statusObserved && child.status === "running") this.status(id, "no_updates", ts);
  }

  close(ts: number): void {
    for (const [id, child] of this.children) if (child.status === "running") this.status(id, "interrupted", ts);
  }

  private register(id: string, parent: string, title: string, ts: number): boolean {
    if (this.children.has(id)) return true;
    if (this.dropped.has(id)) return false;
    if (parent !== this.root() && !this.children.has(parent)) {
      this.dropped.add(id);
      this.onDrop(id);
      return false;
    }
    const launch = [...this.launches.values()].find((l) => !l.linked && !l.ended && l.parent === parent && l.input["description"] === title);
    if (launch) launch.linked = true;
    this.children.set(id, { mapper: new AcpUpdateMapper(this.runId), status: "running", statusObserved: false });
    this.emit({
      type: "subagent.started",
      runId: this.runId,
      ts,
      subagentId: id,
      title,
      ...(parent !== this.root() ? { parentSubagentId: parent } : {}),
      ...(launch
        ? {
            toolCallId: launch.id,
            prompt: string(launch.input["prompt"]),
            agentType: string(launch.input["agent"]),
            model: string(launch.input["model"]),
            background: launch.input["background"] === true,
          }
        : {}),
    });
    return true;
  }

  private map(id: string, update: SessionUpdate, ts: number): void {
    this.observe(id, update, ts);
    for (const event of this.children.get(id)!.mapper.map(update, ts)) this.emit({ ...event, subagentId: id });
  }

  private status(id: string, native: string, ts: number, error?: string): void {
    const child = this.children.get(id);
    if (!child || native === "created") return;
    const status = statuses[native];
    if (!status || child.status === status) return;
    child.status = status;
    const ended = status === "running" ? null : child.mapper.endTurn(ts);
    for (const event of ended?.events ?? []) this.emit({ ...event, subagentId: id });
    this.emit({
      type: "subagent.updated",
      runId: this.runId,
      ts,
      subagentId: id,
      status,
      ...(status === "failed" && error ? { error } : {}),
      ...(ended?.text && status === "completed" ? { result: ended.text } : {}),
    });
  }
}
