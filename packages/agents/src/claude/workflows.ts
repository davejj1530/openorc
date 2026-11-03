import type { AgentEvent, SubagentStatus } from "@openorc/protocol";
import { contentText, isRecord, num, str } from "./stream-values.js";

type Start = Extract<AgentEvent, { type: "subagent.started" }>;
interface WorkflowAgent {
  start: Start;
  status: SubagentStatus;
  agentId: string | null;
  signature?: string;
  progressSignature?: string;
  fullPrompt?: string;
}
interface Workflow {
  start: Start;
  taskId: string | null;
  status: SubagentStatus;
  entries: Map<string, Record<string, unknown>>;
  agents: Map<number, WorkflowAgent>;
  phase?: string;
}
export interface WorkflowTranscriptTarget {
  agentId: string;
  subagentId: string;
  finished: boolean;
  workflowEnded: boolean;
}
interface Transcript {
  workflow: Workflow;
  agent: WorkflowAgent;
  promptRead: boolean;
  lastText?: string;
}

const agentStatus: Record<string, SubagentStatus> = { start: "running", progress: "running", done: "completed", error: "failed" };

function taskPrompt(text: string): string {
  if (!text.startsWith("[Workflow harness — computed task]")) return text;
  const boundary = text.indexOf("The computed task text follows:\n");
  return boundary < 0
    ? text
    : text
        .slice(boundary + "The computed task text follows:\n".length)
        .replace(/^  /gm, "")
        .trimEnd();
}
/** Progress entries keep their identity across retries, while every attempt has a separate transcript file. */
export class ClaudeWorkflows {
  sessionId: string | null = null;
  private readonly workflows = new Map<string, Workflow>();
  private readonly tasks = new Map<string, string>();
  private readonly transcripts = new Map<string, Transcript>();

  constructor(private readonly runId: string) {}

  observeSession(message: Record<string, unknown>): void {
    const id = str(message["session_id"]);
    if (id) this.sessionId = id;
  }

  launch(id: string, input: unknown, parent: string | null, ts: number, out: AgentEvent[]): void {
    if (this.workflows.has(id)) return;
    const value = isRecord(input) ? input : {};
    const start: Start = {
      type: "subagent.started",
      runId: this.runId,
      ts,
      subagentId: id,
      toolCallId: id,
      title: str(value["description"]) ?? "Workflow",
      prompt: str(value["description"]) ?? "Workflow",
      agentType: "workflow",
      background: true,
      parentSubagentId: parent ?? undefined,
    };
    this.workflows.set(id, { start, taskId: null, status: "running", entries: new Map(), agents: new Map() });
    out.push(start);
  }

  task(msg: Record<string, unknown>, ts: number, out: AgentEvent[]): boolean {
    const taskId = str(msg["task_id"]);
    const id = str(msg["tool_use_id"]) ?? (taskId ? this.tasks.get(taskId) : undefined);
    if (!id) return false;
    if (msg["task_type"] === "local_workflow") this.launch(id, { description: msg["workflow_name"] ?? msg["description"], script: msg["prompt"] }, null, ts, out);
    const workflow = this.workflows.get(id);
    if (!workflow) return false;
    if (taskId) {
      workflow.taskId = taskId;
      this.tasks.set(taskId, id);
    }
    if (msg["subtype"] === "task_started") this.started(workflow, msg, ts, out);
    this.progress(workflow, msg["workflow_progress"], ts, out);
    if (msg["subtype"] === "task_notification") {
      const status = msg["status"];
      this.finish(workflow, status === "completed" || status === "stopped" ? status : "failed", str(msg["summary"]) ?? undefined, ts, out);
    }
    return true;
  }

  private started(workflow: Workflow, msg: Record<string, unknown>, ts: number, out: AgentEvent[]): void {
    const title = str(msg["workflow_name"]) ?? str(msg["description"]) ?? workflow.start.title;
    const description = str(msg["description"]);
    workflow.start = { ...workflow.start, title, prompt: description && description !== title ? `${title}\n\n${description}` : title };
    out.push({ ...workflow.start, ts });
    this.update(workflow.start.subagentId, ts, out, { taskId: workflow.taskId ?? undefined, status: workflow.status });
  }

  private progress(workflow: Workflow, entries: unknown, ts: number, out: AgentEvent[]): void {
    if (!Array.isArray(entries)) return;
    for (const value of entries) {
      if (!isRecord(value) || num(value["index"]) === undefined) continue;
      const key = `${String(value["type"])}:${String(value["index"])}`;
      if (JSON.stringify(workflow.entries.get(key)) === JSON.stringify(value)) continue;
      const entry = value;
      workflow.entries.set(key, entry);
      if (entry["type"] === "workflow_agent") this.agent(workflow, entry, ts, out);
    }
    const phases = [...workflow.entries.values()].filter((entry) => entry["type"] === "workflow_phase").sort((a, b) => Number(a["index"]) - Number(b["index"]));
    const runningPhases = new Set(
      [...workflow.entries.values()].filter((entry) => entry["type"] === "workflow_agent" && (entry["state"] === "start" || entry["state"] === "progress")).map((entry) => entry["phaseTitle"]),
    );
    const phase = phases.find((entry) => runningPhases.has(entry["title"])) ?? phases.at(-1);
    const progress = phase ? `Phase ${String(phase["index"])} · ${String(phase["title"] ?? "Working")}` : undefined;
    if (progress && workflow.phase !== progress) {
      workflow.phase = progress;
      this.update(workflow.start.subagentId, ts, out, { progress });
    }
  }

  private agent(workflow: Workflow, entry: Record<string, unknown>, ts: number, out: AgentEvent[]): void {
    const index = Number(entry["index"]);
    let agent = workflow.agents.get(index);
    if (!agent) {
      agent = {
        start: {
          type: "subagent.started",
          runId: this.runId,
          ts: num(entry["startedAt"]) ?? ts,
          subagentId: `${workflow.start.subagentId}:${index}`,
          parentSubagentId: workflow.start.subagentId,
          title: "Workflow agent",
        },
        status: "running",
        agentId: null,
      };
      workflow.agents.set(index, agent);
    }
    agent.status = agentStatus[String(entry["state"])] ?? agent.status;
    if (workflow.status !== "running" && agent.status === "running") agent.status = "stopped";
    agent.agentId = str(entry["agentId"]) ?? agent.agentId;
    if (agent.agentId && !this.transcripts.has(agent.agentId)) this.transcripts.set(agent.agentId, { workflow, agent, promptRead: false });
    this.agentMetadata(agent, entry);
    this.announce(agent, ts, out);
    this.agentProgress(agent, entry, ts, out);
  }

  private agentMetadata(agent: WorkflowAgent, entry: Record<string, unknown>): void {
    agent.start = {
      ...agent.start,
      title: str(entry["label"]) ?? agent.start.title,
      agentType: str(entry["agentType"]) ?? str(entry["phaseTitle"]) ?? "workflow agent",
      model: str(entry["model"]) ?? undefined,
      prompt: agent.fullPrompt ?? str(entry["promptPreview"]) ?? undefined,
      group: str(entry["phaseTitle"]) ?? undefined,
    };
  }

  private agentProgress(agent: WorkflowAgent, entry: Record<string, unknown>, ts: number, out: AgentEvent[]): void {
    const result = agent.agentId ? this.transcripts.get(agent.agentId)?.lastText : undefined;
    const detail = {
      status: agent.status,
      progress: str(entry["lastToolSummary"]) ?? str(entry["lastToolName"]) ?? undefined,
      result: agent.status === "completed" ? (result ?? str(entry["resultPreview"]) ?? undefined) : undefined,
      error: agent.status === "failed" ? (str(entry["error"]) ?? undefined) : undefined,
    };
    const signature = JSON.stringify(detail);
    if (signature === agent.progressSignature) return;
    agent.progressSignature = signature;
    this.update(agent.start.subagentId, ts, out, detail);
  }

  private announce(agent: WorkflowAgent, ts: number, out: AgentEvent[]): void {
    const signature = JSON.stringify(agent.start);
    if (signature === agent.signature) return;
    agent.signature = signature;
    out.push({ ...agent.start, ts });
  }

  private finish(workflow: Workflow, status: SubagentStatus, result: string | undefined, ts: number, out: AgentEvent[]): void {
    workflow.status = status;
    for (const agent of workflow.agents.values()) {
      if (agent.status !== "running") continue;
      agent.status = "stopped";
      this.update(agent.start.subagentId, ts, out, { status: "stopped" });
    }
    this.update(workflow.start.subagentId, ts, out, { status, result: status === "stopped" ? undefined : result });
  }

  result(id: string, isError: boolean, ts: number, out: AgentEvent[]): void {
    const workflow = this.workflows.get(id);
    if (workflow && !workflow.taskId && isError) this.finish(workflow, "failed", undefined, ts, out);
  }

  taskId(id: string): string | null {
    const workflow = this.workflows.get(id);
    return workflow?.status === "running" ? workflow.taskId : null;
  }

  targets(): WorkflowTranscriptTarget[] {
    return [...this.transcripts].map(([agentId, { agent, workflow }]) => ({
      agentId,
      subagentId: agent.start.subagentId,
      finished: agent.agentId !== agentId || agent.status !== "running",
      workflowEnded: workflow.status !== "running",
    }));
  }

  message(agentId: string, msg: Record<string, unknown>, ts: number, out: AgentEvent[]): Record<string, unknown> | null {
    const source = this.transcripts.get(agentId);
    if (!source || !isRecord(msg["message"]) || !["assistant", "user"].includes(String(msg["type"]))) return null;
    const { agent } = source;
    const message = msg["message"];
    const text = contentText(message["content"]);
    if (msg["type"] === "user" && text && !source.promptRead) {
      source.promptRead = true;
      if (agent.agentId === agentId) {
        agent.fullPrompt = taskPrompt(text);
        agent.start = { ...agent.start, prompt: agent.fullPrompt };
        this.announce(agent, ts, out);
      }
      return null;
    }
    if (msg["type"] === "assistant" && text) {
      source.lastText = text;
      if (agent.agentId === agentId && agent.status === "completed") this.update(agent.start.subagentId, ts, out, { result: text });
    }
    // On-disk assistant records can share a message id while holding different content blocks.
    const id = `workflow:${agentId}:${String(msg["uuid"])}`;
    return { ...msg, message: { ...message, id }, parent_tool_use_id: agent.start.subagentId };
  }

  private update(id: string, ts: number, out: AgentEvent[], detail: Omit<Extract<AgentEvent, { type: "subagent.updated" }>, "type" | "runId" | "subagentId" | "ts">): void {
    out.push({ type: "subagent.updated", runId: this.runId, subagentId: id, ts, ...detail });
  }
}
