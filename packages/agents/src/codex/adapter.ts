import { spawnAgentProcess } from "../process-recovery.js";
import { withCodexConnection } from "./connection.js";
import { mapNotification } from "./notifications.js";
import { codexMcpApps } from "./mcp-apps.js";
import { modelEfforts, normalizeModelEffort, normalizeModelSettings } from "@openorc/protocol";
import type { AgentEvent, ApprovalDecision, ApprovalKind, ApprovalResolution, RunSpec } from "@openorc/protocol";
import { agentBinary } from "../bin.js";
import { StdioJsonRpc, type JsonRpcServerRequest } from "../jsonrpc.js";
import { RunHandle } from "../run-handle.js";
import { stopProcess, waitForProcessGroup } from "../process-lifetime.js";
import { partitionAttachments, withAttachedFiles } from "../attachments.js";
import type { AgentLaunchEnvironment } from "../launch-environment.js";

/**
 * A turn's input items. Codex has one attachment slot and it takes pictures,
 * so anything else the user attached is named in the text instead and Codex
 * opens it with its own tools.
 */
function attachmentInput(text: string, attachments: string[] | undefined): unknown[] {
  const { images, files } = partitionAttachments(attachments);
  const input: unknown[] = [{ type: "text", text: withAttachedFiles(text, files, "open them to read") }];
  for (const path of images) input.push({ type: "localImage", path });
  return input;
}

export interface CodexApprovalRequest {
  runId: string;
  approvalId: string;
  kind: ApprovalKind;
  params: unknown;
  /** An MCP tool's confirmation form is answered once; OpenOrc has no way to have Codex remember it. */
  onceOnly: boolean;
}

export interface CodexAdapterOptions {
  binary?: string;
  env?: NodeJS.ProcessEnv;
  mcpServerName?: string;
  clientVersion?: string;
  /** The UI answers these. Spikes auto-allow. */
  onApproval: (request: CodexApprovalRequest) => Promise<ApprovalDecision | ApprovalResolution>;
}

export interface CodexModel {
  id: string;
  model: string;
  displayName: string;
  description: string;
  isDefault: boolean;
  hidden: boolean;
  efforts: string[];
  defaultEffort: string | null;
  serviceTiers?: { id: string; name: string; description: string }[];
  additionalSpeedTiers?: string[];
}

const decisionFor: Record<ApprovalDecision, string> = {
  allow: "accept",
  allow_for_run: "acceptForSession",
  deny: "decline",
};

function completedTurnStatus(status: string | undefined): "success" | "cancelled" | "error" {
  if (status === "completed") return "success";
  if (status === "interrupted") return "cancelled";
  return "error";
}

function sandboxFor(spec: RunSpec): "read-only" | "danger-full-access" | "workspace-write" {
  if (spec.mode === "plan" || spec.permissionMode === "review") return "read-only";
  if (spec.permissionMode === "autonomous") return "danger-full-access";
  return "workspace-write";
}

/** One source of Codex settings for a folder. `disabledReason` says why Codex ignores it, such as an untrusted folder. */
interface CodexConfigLayer {
  name?: { type?: string };
  disabledReason?: string | null;
}

/**
 * Codex applies a folder's .codex settings, hooks and exec policies once its repository is trusted, and a worktree
 * inherits that trust. Nothing turns this off for one run, so a run in an unvetted checkout refuses when it would happen.
 */
async function refuseProjectConfig(rpc: StdioJsonRpc, cwd: string): Promise<void> {
  const read = await rpc.request<{ layers?: CodexConfigLayer[] }>("config/read", { cwd, includeLayers: true });
  // A Codex that doesn't list its settings' sources can't show it would skip the checkout's.
  if (!read.layers)
    throw new Error("This version of Codex can't show whether it would load the pull request's own .codex settings, which can run commands. Update Codex, or review it with a Claude model instead.");
  if (read.layers.some((layer) => layer.name?.type === "project" && !layer.disabledReason))
    throw new Error("Codex trusts this repository, so it would load the pull request's own .codex settings, which can run commands. Review it with a Claude model instead.");
}

/** Settings the thread starts with: in Plan, no MCP server but the app's. An unvetted checkout's own settings refuse the run. */
async function threadConfig(rpc: StdioJsonRpc, spec: RunSpec, serverName: string): Promise<Record<string, unknown>> {
  if (spec.untrustedCheckout) await refuseProjectConfig(rpc, spec.cwd);
  const config: Record<string, unknown> = {};
  if (spec.mode !== "plan") return config;
  // Disable external MCP servers even if the user's native config pre-approves their tools.
  const loaded = await rpc.request<{ config: { mcp_servers?: Record<string, unknown> } }>("config/read", { cwd: spec.cwd, includeLayers: false });
  for (const name of Object.keys(loaded.config.mcp_servers ?? {})) if (name !== serverName) config[`mcp_servers.${name}.enabled`] = false;
  return config;
}

function resumedThreadMethod(fork: boolean | undefined): "thread/fork" | "thread/resume" {
  return fork ? "thread/fork" : "thread/resume";
}

const approvalKindFor: Record<string, ApprovalKind> = {
  "item/commandExecution/requestApproval": "command",
  "item/fileChange/requestApproval": "file_change",
  "item/permissions/requestApproval": "permissions",
  "item/tool/requestUserInput": "user_input",
  "mcpServer/elicitation/request": "tool",
};

const clientInfo = (version: string) => ({ name: "openorc", title: "OpenOrc", version });
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Drives `codex app-server` over stdio using the v2 JSON-RPC surface the
 * Codex IDE integrations use. Experimental capabilities stay off.
 */
export class CodexAdapter {
  constructor(private readonly options: CodexAdapterOptions) {}

  /** Models the installed Codex can actually run. Feeds the model picker. */
  async listModels(launch?: AgentLaunchEnvironment): Promise<CodexModel[]> {
    const binary = launch?.binary ?? this.options.binary ?? agentBinary("codex");
    return withCodexConnection({ binary, env: launch ? { ...launch.env, ...this.options.env } : { ...process.env, ...this.options.env } }, async (rpc) => {
      type WireModel = CodexModel & { supportedReasoningEfforts?: { reasoningEffort: string }[]; defaultReasoningEffort?: string };
      const rows: WireModel[] = [];
      const cursors = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = await rpc.request<{ data: WireModel[]; nextCursor?: string | null }>("model/list", { includeHidden: false, limit: 100, ...(cursor ? { cursor } : {}) }, 8000);
        rows.push(...page.data);
        cursor = page.nextCursor ?? undefined;
        if (cursor && cursors.has(cursor)) throw new Error("Codex model pagination repeated a cursor");
        if (cursor) cursors.add(cursor);
      } while (cursor);
      return [...new Map(rows.map((m) => [m.model, m])).values()].map((m) => ({
        id: m.id,
        model: m.model,
        displayName: m.displayName,
        description: m.description,
        isDefault: m.isDefault,
        hidden: m.hidden,
        efforts: modelEfforts(
          "codex",
          m.model,
          (m.supportedReasoningEfforts ?? []).map((e) => e.reasoningEffort),
        ),
        defaultEffort: normalizeModelEffort("codex", m.model, m.defaultReasoningEffort ?? null),
        serviceTiers: m.serviceTiers ?? [],
        additionalSpeedTiers: m.additionalSpeedTiers ?? [],
      }));
    });
  }

  start(spec: RunSpec, launch: AgentLaunchEnvironment): RunHandle {
    spec = normalizeModelSettings(spec);
    const binary = launch.binary;
    const serverName = spec.internalMcp?.serverName ?? this.options.mcpServerName ?? "openorc";
    /** The tier every turn asks for; turn/start takes it per turn, so Fast can change without a new process. */
    let serviceTier = spec.fastMode ? "priority" : "default";
    const args = ["app-server", "--listen", "stdio://", "-c", `service_tier=${JSON.stringify(serviceTier)}`];
    if (spec.mode === "plan") {
      for (const feature of ["multi_agent", "browser_use", "computer_use", "apps", "plugins"]) args.push("-c", `features.${feature}=false`);
    }
    if (spec.fastMode) args.push("-c", "features.fast_mode=true");
    // OpenOrc's MCP address carries a secret, so it travels in the thread's settings over stdin, never in argv.
    const mcpUrl = spec.internalMcp?.url ?? spec.mcpUrl;
    const mcpConfig: Record<string, unknown> = mcpUrl
      ? {
          [`mcp_servers.${serverName}.url`]: mcpUrl,
          ...Object.fromEntries((spec.internalMcp?.toolNames ?? []).map((name) => [`mcp_servers.${serverName}.tools.${name}.approval_mode`, "approve"])),
        }
      : {};
    if (spec.effort) args.push("-c", `model_reasoning_effort="${spec.effort}"`);
    const env: NodeJS.ProcessEnv = { ...launch.env, ...this.options.env };
    const startedAt = Date.now();
    const proc = spawnAgentProcess(binary, args, { cwd: spec.cwd, env, registry: launch.processRegistry });
    const rpc = new StdioJsonRpc(proc);

    let handle: RunHandle;
    let resolvedModel = spec.model;
    /** Settings changed since the thread started. turn/start applies them to that turn and the ones after it. */
    const overrides: { model?: string; effort?: string } = {};
    let threadId: string | null = null;
    let activeTurnId: string | null = null;
    let compaction: { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void; turnId: string | null; manual: boolean; activityId: string; finished: boolean } | null = null;
    let compactions = 0;
    const compactionTurns = new Set<string>();
    const beginCompaction = (manual: boolean, itemId?: string) => {
      if (compaction) {
        if (!compaction.manual && compaction.finished && itemId && itemId !== compaction.activityId) {
          compaction.activityId = itemId;
          compaction.finished = false;
          emit({ type: "activity.updated", runId: spec.runId, ts: now(), activityId: itemId, label: "Compacting context", status: "running", detail: { mode: "automatic" } });
        }
        return compaction;
      }
      let resolve!: () => void;
      let reject!: (error: Error) => void;
      const promise = new Promise<void>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      // Automatic compaction may have no caller awaiting it yet.
      void promise.catch(() => {});
      const pending = { promise, resolve, reject, turnId: manual ? null : activeTurnId, manual, activityId: itemId ?? `manual-compaction-${++compactions}`, finished: false };
      compaction = pending;
      emit({
        type: "activity.updated",
        runId: spec.runId,
        ts: now(),
        activityId: pending.activityId,
        label: "Compacting context",
        status: "running",
        detail: { mode: manual ? "manual" : "automatic" },
      });
      return pending;
    };
    let turns = 0;
    const notificationState = { summaryIndex: new Map<string, number>(), buffering: new Set<string>() };
    const emit = (ev: AgentEvent) => handle.emit("event", ev);
    const now = () => Date.now();

    const finishCompaction = (status: "success" | "error" | "cancelled" | "disconnected", text?: string) => {
      if (!compaction || compaction.finished) return;
      compaction.finished = true;
      emit({ type: "activity.updated", runId: spec.runId, ts: now(), activityId: compaction.activityId, label: "Compacting context", status, ...(text ? { text } : {}) });
    };

    const done = new Promise<number | null>((resolve) => {
      proc.on("close", async (code) => {
        await waitForProcessGroup(proc);
        finishCompaction("disconnected");
        compaction?.reject(new Error("Codex exited before context compaction finished. Your draft has not been sent."));
        compaction = null;
        emit({
          type: "session.completed",
          runId: spec.runId,
          ts: now(),
          status: code === 0 || code === null ? "success" : "error",
          durationMs: now() - startedAt,
          turns,
        });
        handle.emit("exit", code);
        resolve(code);
      });
    });
    proc.once("exit", () => {
      try {
        stopProcess(proc);
      } catch (error) {
        // Keep waiting for descendant writers even when cleanup is denied;
        // an exit event callback must never throw into the host process.
        handle.emit("event", { type: "error", runId: spec.runId, ts: Date.now(), message: `Process cleanup needs attention: ${error instanceof Error ? error.message : String(error)}`, fatal: false });
      }
    });

    const startTurn = async (text: string, attachments?: string[]): Promise<void> => {
      if (!threadId) throw new Error("thread not started");
      // A compact turn cannot accept steering. Wait for its terminal event,
      // including the gap between accepting compact/start and item/started.
      while (compaction) await compaction.promise;
      const input: unknown[] = attachmentInput(text, attachments);
      // A message during a turn steers it, the way Enter does in the Codex app; between turns it starts the next one.
      if (activeTurnId) {
        // A timeout cannot prove the input was rejected. Keep this send pending
        // until the provider responds (or exits), so a slow ACK cannot invite a duplicate retry.
        await rpc.request("turn/steer", { threadId, input, expectedTurnId: activeTurnId }, 0);
        return;
      }
      // Reasoning summaries are off unless the turn asks; "auto" is what the Codex app shows. Models without summaries send an empty reasoning item.
      await rpc.request(
        "turn/start",
        {
          threadId,
          input,
          summary: "auto",
          serviceTier,
          approvalsReviewer: "user",
          ...overrides,
          ...(spec.mode === "plan"
            ? {
                collaborationMode: { mode: "plan", settings: { model: resolvedModel, reasoning_effort: overrides.effort ?? spec.effort ?? null, developer_instructions: null } },
                sandboxPolicy: { type: "readOnly" },
                approvalPolicy: "never",
              }
            : {}),
        },
        0,
      );
    };

    handle = new RunHandle(spec.runId, {
      mcpApps: codexMcpApps(rpc, () => threadId),
      interrupt: async () => {
        // Cancellation is scoped to a turn, including a manual compaction turn.
        // Await the response so a rejected Stop is visible to the caller.
        if (!threadId || !activeTurnId) return;
        await rpc.request("turn/interrupt", { threadId, turnId: activeTurnId }, 15_000);
      },
      close: () => stopProcess(proc),
      send: startTurn,
      applySettings: async ({ model, effort, fastMode }) => {
        if (!threadId) throw new Error("Codex has no thread yet.");
        if (activeTurnId || compaction) throw new Error("Wait for the current turn to finish before changing its settings.");
        if (model !== undefined) {
          overrides.model = model;
          resolvedModel = model;
        }
        if (effort !== undefined) overrides.effort = effort;
        if (fastMode !== undefined) serviceTier = fastMode ? "priority" : "default";
      },
      compacting: () => Boolean(compaction),
      canSteer: () => Boolean(threadId && activeTurnId && !compaction),
      steer: async (text, attachments) => {
        // Unlike send(), this may only reach the exact running turn. Never
        // convert a late correction into an unreserved follow-up turn.
        const expectedTurnId = activeTurnId;
        if (!threadId || !expectedTurnId || compaction) return "unavailable";
        const input: unknown[] = attachmentInput(text, attachments);
        await rpc.request("turn/steer", { threadId, input, expectedTurnId }, 15_000);
        return "accepted";
      },
      compact: async () => {
        if (!threadId) throw new Error("thread not started");
        if (compaction) return compaction.promise;
        if (activeTurnId) throw new Error("Wait for the current turn to finish before compacting.");
        const pending = beginCompaction(true);
        try {
          await rpc.request("thread/compact/start", { threadId });
        } catch (error) {
          finishCompaction("error", error instanceof Error ? error.message : String(error));
          pending.reject(error instanceof Error ? error : new Error(String(error)));
          if (compaction === pending) compaction = null;
        }
        return pending.promise;
      },
      done,
    });

    proc.on("error", (e) => {
      emit({ type: "error", runId: spec.runId, ts: now(), message: e.message, fatal: true });
      if (!proc.pid) proc.emit("exit", null, null);
    });
    rpc.on("stderr", (line) => emit({ type: "error", runId: spec.runId, ts: now(), message: line, fatal: false }));
    rpc.on("parseError", (line) => emit({ type: "error", runId: spec.runId, ts: now(), message: `unparseable: ${line.slice(0, 200)}`, fatal: false }));
    rpc.on("notification", (n) => {
      const params = (n.params ?? {}) as {
        turn?: { id?: string; status?: string; error?: { message?: string } };
        turnId?: string;
        threadId?: string;
        willRetry?: boolean;
        error?: { message?: string };
        item?: { type?: string; id?: string };
      };
      // Native subagents share this transport. Retain their raw events without
      // changing the owning thread's turn, compaction, usage or transcript.
      if (typeof params.threadId === "string" && params.threadId !== threadId) {
        emit({ type: "raw", runId: spec.runId, ts: now(), agent: "codex", payload: { method: n.method, params: n.params } });
        return;
      }
      const turn = params.turn;
      let maintenance = false;
      if (n.method === "error" && params.willRetry === false && compaction) {
        const error = new Error(params.error?.message ?? "Context compaction failed. Your draft has not been sent.");
        finishCompaction("error", error.message);
        compaction.reject(error);
      }
      if (n.method === "thread/closed" && params.threadId === threadId) stopProcess(proc);
      if (n.method === "turn/started" && turn?.id) {
        activeTurnId = turn.id;
        // A manual compaction runs as a turn of its own; it is maintenance, not a prompt being answered.
        if (compaction?.manual && !compaction.turnId) compaction.turnId = turn.id;
        else emit({ type: "turn.started", runId: spec.runId, ts: now(), turnId: turn.id });
      }
      if (n.method === "item/started" && params.item?.type === "contextCompaction") {
        const pending = beginCompaction(false, params.item.id);
        pending.turnId = params.turnId ?? activeTurnId;
        if (pending.turnId) compactionTurns.add(pending.turnId);
      }
      if ((n.method === "item/completed" && params.item?.type === "contextCompaction") || n.method === "thread/compacted") {
        // Manual maintenance is only successful when its turn succeeds.
        if (compaction) {
          if (!compaction.manual) {
            finishCompaction("success");
            const pending = compaction;
            compaction = null;
            pending.resolve();
          }
        } else if (n.method !== "thread/compacted" || !compactionTurns.has(params.turnId ?? "")) {
          // Older providers can report only completion. Do not create an input
          // barrier after the maintenance has already ended.
          emit({ type: "activity.updated", runId: spec.runId, ts: now(), activityId: params.item?.id ?? `compaction-${params.turnId}`, label: "Compacting context", status: "success" });
          if (params.turnId) compactionTurns.add(params.turnId);
        }
      }
      if (n.method === "turn/completed") {
        if (turn?.id === activeTurnId) activeTurnId = null;
        if (compaction && turn?.id === compaction.turnId) {
          finishCompaction(completedTurnStatus(turn?.status), turn?.error?.message);
          const pending = compaction;
          maintenance = pending.manual;
          compaction = null;
          if (turn?.status === "completed") pending.resolve();
          else pending.reject(new Error(turn?.error?.message ?? "Context compaction did not finish. Your draft has not been sent."));
        }
        if (!maintenance) turns += 1;
      }
      // Publish after updating control state: completion callbacks can send the
      // next queued message synchronously. Manual maintenance isn't an agent reply.
      emit({ type: "raw", runId: spec.runId, ts: now(), agent: "codex", payload: { method: n.method, params: n.params } });
      if (!maintenance) for (const ev of mapNotification(spec.runId, n.method, n.params, notificationState)) emit(ev);
    });
    rpc.on("request", (req) => void this.handleServerRequest(spec.runId, rpc, req, emit));

    void (async () => {
      try {
        await rpc.request("initialize", {
          clientInfo: clientInfo(this.options.clientVersion ?? "0.0.0"),
          capabilities: { experimentalApi: true, extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } } },
        });
        rpc.notify("initialized", {});
        const planConfig = await threadConfig(rpc, spec, serverName);
        const threadParams = {
          config: { ...planConfig, ...mcpConfig, "sandbox_workspace_write.network_access": false },
          serviceTier,
          cwd: spec.cwd,
          approvalPolicy: spec.mode === "plan" || spec.permissionMode === "autonomous" ? "never" : "on-request",
          approvalsReviewer: "user",
          sandbox: sandboxFor(spec),
          ...(spec.model ? { model: spec.model } : {}),
          ...(spec.systemPromptAppendix ? { developerInstructions: spec.systemPromptAppendix } : {}),
        };
        const started = spec.resumeSessionId
          ? await rpc.request<{ thread: { id: string }; model: string }>(resumedThreadMethod(spec.forkSession), { threadId: spec.resumeSessionId, ...threadParams, excludeTurns: true })
          : await rpc.request<{ thread: { id: string }; model: string }>("thread/start", threadParams);
        threadId = started.thread.id;
        resolvedModel = started.model ?? spec.model;
        emit({ type: "session.started", runId: spec.runId, ts: now(), agent: "codex", externalSessionId: threadId, model: started.model ?? null });
        await startTurn(spec.prompt, spec.attachments);
      } catch (e) {
        emit({ type: "error", runId: spec.runId, ts: now(), message: e instanceof Error ? e.message : String(e), fatal: true });
        stopProcess(proc);
      }
    })();

    return handle;
  }

  /**
   * Codex asks the client four different questions with four response shapes.
   * They all surface in OpenOrc as one approval card.
   */
  private async handleServerRequest(runId: string, rpc: StdioJsonRpc, req: JsonRpcServerRequest, emit: (ev: AgentEvent) => void): Promise<void> {
    const kind = approvalKindFor[req.method];
    if (!kind) {
      rpc.respondError(req.id, -32601, `OpenOrc does not handle ${req.method}`);
      return;
    }
    const approvalId = String(req.id);
    const p = req.params ?? {};
    if (!isRecord(p) || (kind === "permissions" && p["permissions"] != null && !isRecord(p["permissions"]))) {
      rpc.respondError(req.id, -32602, "Invalid approval request parameters.");
      return;
    }
    let formContent: Record<string, unknown> | null = null;
    try {
      if (req.method === "mcpServer/elicitation/request") formContent = fillElicitationForm(p);
    } catch (error) {
      rpc.respondError(req.id, -32602, error instanceof Error ? error.message : String(error));
      return;
    }
    // The host announces the request (it derives a better tool name and detail); the adapter reports how it was resolved.
    let answer: ApprovalDecision | ApprovalResolution;
    try {
      answer = await this.options.onApproval({ runId, approvalId, kind, params: req.params, onceOnly: req.method === "mcpServer/elicitation/request" });
    } catch (error) {
      rpc.respondError(req.id, -32000, error instanceof Error ? error.message : String(error));
      return;
    }
    const resolution: ApprovalResolution = typeof answer === "string" ? { decision: answer } : answer;

    if (kind === "user_input") {
      if (resolution.decision === "deny") {
        rpc.respondError(req.id, -32000, "the user declined to answer");
      } else {
        const answers: Record<string, { answers: string[] }> = {};
        for (const [id, values] of Object.entries(resolution.answers ?? {})) answers[id] = { answers: values };
        rpc.respond(req.id, { answers });
      }
    } else {
      rpc.respond(req.id, responseFor(req.method, p, resolution.decision, formContent));
    }
    emit({ type: "approval.resolved", runId, ts: Date.now(), approvalId, decision: resolution.decision, ...(resolution.answers ? { answers: resolution.answers } : {}) });
  }
}

function responseFor(method: string, p: Record<string, unknown>, decision: ApprovalDecision, formContent: Record<string, unknown> | null): unknown {
  switch (method) {
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval":
      return { decision: decisionFor[decision] };
    case "item/permissions/requestApproval": {
      // Grant exactly what was requested, nothing wider.
      if (decision === "deny") return { permissions: {}, scope: "turn" };
      const requested = p["permissions"] == null ? {} : (p["permissions"] as Record<string, unknown>);
      const granted: Record<string, unknown> = {};
      if (requested["network"]) granted["network"] = requested["network"];
      if (requested["fileSystem"]) granted["fileSystem"] = requested["fileSystem"];
      return { permissions: granted, scope: decision === "allow_for_run" ? "session" : "turn" };
    }
    case "mcpServer/elicitation/request": {
      if (decision === "deny") return { action: "decline", content: null, _meta: null };
      return { action: "accept", content: formContent, _meta: null };
    }
    default:
      return { decision: decisionFor[decision] };
  }
}

/**
 * Codex confirms MCP tool calls through an elicitation form. We answer the
 * form with affirmative defaults: booleans true, enums first option, strings
 * empty. Anything richer needs a real UI.
 */
function fillElicitationForm(p: Record<string, unknown>): Record<string, unknown> | null {
  if (p["mode"] !== "form") return null;
  const schema = p["requestedSchema"];
  if (!isRecord(schema)) throw new Error("Invalid elicitation form schema.");
  const props = schema["properties"] ?? {};
  if (!isRecord(props)) throw new Error("Invalid elicitation form schema.");
  const content: Record<string, unknown> = {};
  for (const [name, def] of Object.entries(props)) {
    if (!isRecord(def)) throw new Error("Invalid elicitation form schema.");
    if (Array.isArray(def["enum"]) && def["enum"].length > 0) content[name] = def["enum"][0];
    else if (def["type"] === "boolean") content[name] = true;
    else if (def["type"] === "number" || def["type"] === "integer") content[name] = typeof def["default"] === "number" ? def["default"] : 0;
    else content[name] = typeof def["default"] === "string" ? def["default"] : "";
  }
  return content;
}
