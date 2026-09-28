import { spawnAgentProcess } from "../process-recovery.js";
import { executionMode, executionModeUnavailable } from "@openorc/protocol";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path, { extname } from "node:path";
import readline from "node:readline";
import { Readable, Writable } from "node:stream";
import {
  client,
  ndJsonStream,
  PROTOCOL_VERSION,
  type ContentBlock,
  type McpServer,
  type PermissionOptionKind,
  type PromptResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionConfigOption,
  type StopReason,
  type Usage as AcpUsage,
} from "@agentclientprotocol/sdk";
import type { AgentEvent, ApprovalDecision, ApprovalKind, ApprovalResolution, RunSpec, RunStatus, Usage } from "@openorc/protocol";
import { agentBinary } from "../bin.js";
import type { AgentLaunchEnvironment } from "../launch-environment.js";
import { partitionAttachments, withAttachedFiles } from "../attachments.js";
import { stopProcess, waitForProcessGroup } from "../process-lifetime.js";
import { RunHandle } from "../run-handle.js";
import { stripAnsi } from "../jsonrpc.js";
import { AcpUpdateMapper, type ContextReport } from "./updates.js";
import { planConfig } from "./plan-config.js";
import { questionConfig, questionInstructions } from "./questions.js";

/** A permission the agent asked for, in the app's terms. The host announces it and answers it. */
export interface AcpApprovalRequest {
  runId: string;
  approvalId: string;
  kind: ApprovalKind;
  toolName: string;
  detail: string;
  input: unknown;
}

export interface AcpAdapterOptions {
  binary?: string;
  env?: NodeJS.ProcessEnv;
  mcpServerName?: string;
  clientVersion?: string;
  /** Where a throwaway session is opened to read the model list. Defaults to the home directory. */
  modelsCwd?: string;
  /** The UI answers these. Spikes auto-allow. */
  onApproval: (request: AcpApprovalRequest) => Promise<ApprovalDecision | ApprovalResolution>;
}

/** One model an ACP agent offers, as its `model` configuration option lists it. */
export interface AcpModel {
  /** The value the agent accepts back, for OpenCode `provider/model`. */
  id: string;
  label: string;
  provider: { id: string; label: string };
  isDefault: boolean;
  efforts: string[];
  defaultEffort: string | null;
}

const imageMimeTypes: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };

const statusFor: Record<StopReason, RunStatus> = {
  end_turn: "success",
  cancelled: "cancelled",
  max_tokens: "error",
  max_turn_requests: "max_turns",
  refusal: "error",
};

/** Which option kinds satisfy each app decision, best first. */
const optionKindsFor: Record<ApprovalDecision, readonly PermissionOptionKind[]> = {
  allow: ["allow_once", "allow_always"],
  allow_for_run: ["allow_always", "allow_once"],
  deny: ["reject_once", "reject_always"],
};

const cancelledOutcome: RequestPermissionResponse = { outcome: { outcome: "cancelled" } };

const clientInfo = (version: string) => ({ name: "openorc", title: "OpenOrc", version });

/**
 * Drives an agent that speaks the Agent Client Protocol over stdio. OpenCode
 * is the first; the protocol is the same for any other. The agent keeps its
 * own session store, so a run is one process holding one session, prompted
 * once per turn.
 */
function planInstructions(mode: RunSpec["mode"], mcpUrl: string | undefined, serverName: string): string {
  if (mode !== "plan") return "";
  const delivery = mcpUrl
    ? `Save the complete proposed plan as Markdown with the ${serverName}_plan_write tool; to revise it, call the tool again with the full document. OpenOrc shows it to the user, who implements it from OpenOrc.`
    : "Return the complete proposed plan as Markdown in your final response.";
  return `${delivery} Use read, glob and grep for investigation; shell, edits and native subagents are blocked in Plan.`;
}

/**
 * Whether a folder holds OpenCode settings of its own. OpenCode 2 skips them in an unvetted checkout when told to, but
 * earlier releases load .opencode plugins regardless, so a run there refuses rather than trust the installed version.
 */
function carriesOpenCodeConfig(cwd: string): boolean {
  return ["opencode.json", "opencode.jsonc", ".opencode"].some((name) => existsSync(path.join(cwd, name)));
}

/** OpenCode's environment for a run: the app's question tool and Plan agent, and nothing from an unvetted checkout. */
function openCodeEnv(base: NodeJS.ProcessEnv, spec: RunSpec, askUser: boolean): NodeJS.ProcessEnv {
  const env = { ...base };
  if (askUser) env["OPENCODE_CONFIG_CONTENT"] = questionConfig(env["OPENCODE_CONFIG_CONTENT"]);
  if (spec.mode === "plan") env["OPENCODE_CONFIG_CONTENT"] = planConfig(env["OPENCODE_CONFIG_CONTENT"], spec.internalMcp);
  // A folder's opencode.json and .opencode plugins are code: an unvetted checkout's never load.
  if (spec.untrustedCheckout) env["OPENCODE_DISABLE_PROJECT_CONFIG"] = "true";
  return env;
}

export class AcpAdapter {
  constructor(private readonly options: AcpAdapterOptions) {}

  /** Models the installed agent can run, read from the configuration a throwaway session reports. */
  async listModels(launch?: AgentLaunchEnvironment): Promise<AcpModel[]> {
    const binary = launch?.binary ?? this.options.binary ?? agentBinary("opencode");
    const env = launch ? { ...launch.env, ...this.options.env } : { ...process.env, ...this.options.env };
    const cwd = this.options.modelsCwd ?? os.homedir();
    const proc = spawn(binary, ["acp"], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    const connection = client({ name: "openorc" }).connect(streamOf(proc));
    let sessionId: string | undefined;
    try {
      await connection.agent.request("initialize", { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {}, clientInfo: clientInfo(this.version) });
      const created = await connection.agent.request("session/new", { cwd, mcpServers: [] });
      sessionId = created.sessionId;
      const models: AcpModel[] = [];
      // ACP's effort option describes only the selected model. Query each in
      // this disposable session; never copy one model's levels to its peers.
      for (const model of modelsFrom(created.configOptions)) {
        const options = model.isDefault ? created.configOptions : (await connection.agent.request("session/set_config_option", { sessionId, configId: "model", value: model.id })).configOptions;
        const option = options?.find((option) => option.id === "effort");
        const effort = option?.type === "select" ? option : undefined;
        const efforts = effort?.options.flatMap((entry) => ("options" in entry ? entry.options : [entry])).map((entry) => entry.value) ?? [];
        // "default" clears the variant override; a current value can otherwise
        // have been inherited from the previously selected model.
        let defaultEffort: string | null = null;
        if (efforts.includes("default")) defaultEffort = "default";
        else if (efforts.length === 1) defaultEffort = efforts[0]!;
        models.push({ ...model, efforts, defaultEffort });
      }
      return models;
    } finally {
      // Also delete after a failed capability query; discovery never sends a prompt.
      if (sessionId) await connection.agent.request("session/delete", { sessionId }).catch(() => undefined);
      connection.close();
      proc.kill("SIGTERM");
    }
  }

  start(spec: RunSpec, launch: AgentLaunchEnvironment): RunHandle {
    const unavailable = executionModeUnavailable(spec.agent, executionMode(spec.mode ?? "act", spec.permissionMode));
    if (unavailable) throw new Error(unavailable);
    if (spec.untrustedCheckout && carriesOpenCodeConfig(spec.cwd))
      throw new Error("OpenCode could load this pull request's own OpenCode settings and plugins, which can run commands. Review it with a Claude model instead.");
    const serverName = spec.internalMcp?.serverName ?? this.options.mcpServerName ?? "openorc";
    const mcpUrl = spec.internalMcp?.url ?? spec.mcpUrl;
    const mcpServers: McpServer[] = mcpUrl ? [{ type: "http", name: serverName, url: mcpUrl, headers: [] }] : [];
    const askUser = Boolean(mcpUrl && spec.internalMcp?.toolNames.includes("ask_user"));
    const env = openCodeEnv({ ...launch.env, ...this.options.env }, spec, askUser);
    const startedAt = Date.now();
    const proc = spawnAgentProcess(launch.binary, ["acp"], { cwd: spec.cwd, env, registry: launch.processRegistry });
    const mapper = new AcpUpdateMapper(spec.runId);
    let handle: RunHandle;
    let sessionId: string | null = null;
    /** The prompt in flight. A maintenance turn compacts the session and is not an answer. */
    let turn: { id: string; startedAt: number; maintenance: { activityId: string; resolve: () => void; reject: (error: Error) => void } | null } | null = null;
    let turns = 0;
    let compactions = 0;
    /** Permission requests the agent is waiting on; a cancelled turn answers them all. */
    const pendingPermissions = new Map<string, (response: RequestPermissionResponse) => void>();
    const emit = (ev: AgentEvent) => handle.emit("event", ev);
    const now = () => Date.now();
    const exited = () => proc.exitCode !== null || proc.signalCode !== null;

    const app = client({ name: "openorc" })
      .onNotification("session/update", ({ params }) => {
        // Replayed history and child sessions belong to other transcripts.
        if (!sessionId || params.sessionId !== sessionId) return;
        emit({ type: "raw", runId: spec.runId, ts: now(), agent: "opencode", payload: params.update });
        for (const ev of mapper.map(params.update, now())) emit(ev);
      })
      .onRequest("session/request_permission", ({ params }) => this.requestPermission(spec.runId, params, pendingPermissions, emit));
    const connection = app.connect(streamOf(proc));

    const settle = (id: string, response: PromptResponse | null, error?: unknown): void => {
      if (!turn || turn.id !== id) return;
      const { startedAt: turnStartedAt, maintenance } = turn;
      turn = null;
      const ended = mapper.endTurn(now());
      for (const ev of ended.events) emit(ev);
      const message = error ? promptFailure(error, spec.model) : null;
      if (maintenance) {
        const ok = !error && response?.stopReason === "end_turn";
        emit({
          type: "activity.updated",
          runId: spec.runId,
          ts: now(),
          activityId: maintenance.activityId,
          label: "Compacting context",
          status: ok ? "success" : "error",
          ...(message ? { text: message } : {}),
        });
        if (ok) maintenance.resolve();
        else maintenance.reject(new Error(message ?? "Context compaction did not finish. Your draft has not been sent."));
        return;
      }
      // A failed turn says why in the conversation itself, the way a Codex provider error does.
      if (message) emit({ type: "activity.updated", runId: spec.runId, ts: now(), activityId: `error-${id}`, label: "Provider error", status: "error", text: message });
      const usage = usageFor(response?.usage, ended.context);
      if (usage) emit({ type: "usage.updated", runId: spec.runId, ts: now(), usage });
      turns += 1;
      emit({
        type: "turn.completed",
        runId: spec.runId,
        ts: now(),
        turnId: id,
        status: error ? "error" : statusFor[response?.stopReason ?? "end_turn"],
        ...(ended.text ? { resultText: ended.text } : {}),
        ...(usage ? { usage } : {}),
        durationMs: now() - turnStartedAt,
      });
    };

    /** One session setting, applied by the agent and answered with the full option list. */
    const setOption = async (configId: "mode" | "model" | "effort", value: string): Promise<SessionConfigOption[] | null | undefined> => {
      if (!sessionId) throw new Error("OpenCode has no session yet.");
      return (await connection.agent.request("session/set_config_option", { sessionId, configId, value })).configOptions;
    };

    /** One prompt is one turn. The agent answers the request when the turn ends, so nothing else may prompt meanwhile. */
    const prompt = async (text: string, attachments: string[] | undefined, appendix?: string, maintenance?: NonNullable<typeof turn>["maintenance"]): Promise<void> => {
      if (!sessionId) throw new Error("OpenCode has no session yet.");
      if (turn) throw new Error("OpenCode is still answering. Wait for the turn to finish.");
      if (exited()) throw new Error("The OpenCode process is no longer running.");
      const blocks = await promptBlocks(text, attachments, [appendix, askUser ? questionInstructions(serverName) : undefined].filter(Boolean).join("\n\n") || undefined);
      const id = randomUUID();
      turn = { id, startedAt: now(), maintenance: maintenance ?? null };
      if (!maintenance) emit({ type: "turn.started", runId: spec.runId, ts: now(), turnId: id });
      void connection.agent.request("session/prompt", { sessionId, prompt: blocks }).then(
        (response) => settle(id, response),
        (error: unknown) => settle(id, null, error),
      );
    };

    const done = new Promise<number | null>((resolve) => {
      proc.on("close", async (code) => {
        await waitForProcessGroup(proc);
        connection.close();
        if (turn) settle(turn.id, null, new Error("OpenCode exited before the turn finished."));
        emit({ type: "session.completed", runId: spec.runId, ts: now(), status: code === 0 || code === null ? "success" : "error", durationMs: now() - startedAt, turns });
        handle.emit("exit", code);
        resolve(code);
      });
    });
    proc.once("exit", () => {
      try {
        stopProcess(proc);
      } catch (error) {
        handle.emit("event", { type: "error", runId: spec.runId, ts: now(), message: `Process cleanup needs attention: ${error instanceof Error ? error.message : String(error)}`, fatal: false });
      }
    });

    handle = new RunHandle(spec.runId, {
      interrupt: () => {
        if (!sessionId || !turn || exited()) return;
        // The protocol requires every open permission request to be answered as cancelled first.
        for (const respond of pendingPermissions.values()) respond(cancelledOutcome);
        pendingPermissions.clear();
        void connection.agent.notify("session/cancel", { sessionId }).catch(() => undefined);
      },
      close: () => stopProcess(proc),
      send: (text, attachments) => prompt(text, attachments),
      // The same options the session was opened with, changed in place; the next prompt uses them.
      applySettings: async ({ model, effort, fastMode }) => {
        if (turn) throw new Error("Wait for the current turn to finish before changing its settings.");
        if (exited()) throw new Error("The OpenCode process is no longer running.");
        if (fastMode !== undefined) throw new Error("OpenOrc does not expose a separate Fast mode control for OpenCode.");
        if (model !== undefined) await setOption("model", model);
        if (effort !== undefined) await setOption("effort", effort);
      },
      compacting: () => Boolean(turn?.maintenance),
      // OpenCode summarises the session when asked to /compact; it runs as a turn of its own.
      compact: () => {
        if (turn?.maintenance) return Promise.resolve();
        if (turn) return Promise.reject(new Error("Wait for the current turn to finish before compacting."));
        const activityId = `manual-compaction-${++compactions}`;
        return new Promise<void>((resolve, reject) => {
          emit({ type: "activity.updated", runId: spec.runId, ts: now(), activityId, label: "Compacting context", status: "running", detail: { mode: "manual" } });
          prompt("/compact", undefined, undefined, { activityId, resolve, reject }).catch((error: unknown) => {
            emit({ type: "activity.updated", runId: spec.runId, ts: now(), activityId, label: "Compacting context", status: "error" });
            reject(error instanceof Error ? error : new Error(String(error)));
          });
        });
      },
      done,
    });

    proc.on("error", (error) => {
      emit({ type: "error", runId: spec.runId, ts: now(), message: error.message, fatal: true });
      // A binary that could not be spawned never exits; end the run here so it does not stay live forever.
      if (!proc.pid) proc.emit("exit", null, null);
    });
    readline.createInterface({ input: proc.stderr, crlfDelay: Infinity }).on("line", (line) => {
      emit({ type: "error", runId: spec.runId, ts: now(), message: stripAnsi(line), fatal: false });
    });

    void (async () => {
      try {
        await connection.agent.request("initialize", {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
          clientInfo: clientInfo(this.version),
        });
        let options: SessionConfigOption[] | null | undefined;
        if (spec.resumeSessionId && spec.forkSession) {
          const forked = await connection.agent.request("session/fork", { sessionId: spec.resumeSessionId, cwd: spec.cwd, mcpServers });
          sessionId = forked.sessionId;
          options = forked.configOptions;
        } else if (spec.resumeSessionId) {
          const resumed = await connection.agent.request("session/resume", { sessionId: spec.resumeSessionId, cwd: spec.cwd, mcpServers });
          sessionId = spec.resumeSessionId;
          options = resumed.configOptions;
        } else {
          const created = await connection.agent.request("session/new", { cwd: spec.cwd, mcpServers });
          sessionId = created.sessionId;
          options = created.configOptions;
        }
        if (spec.mode) options = await setOption("mode", spec.mode === "plan" ? "plan" : "build");
        if (spec.model) options = await setOption("model", spec.model);
        if (spec.effort) options = await setOption("effort", spec.effort);
        emit({ type: "session.started", runId: spec.runId, ts: now(), agent: "opencode", externalSessionId: sessionId, model: currentModel(options) ?? spec.model ?? null });
        await prompt(spec.prompt, spec.attachments, [spec.systemPromptAppendix, planInstructions(spec.mode, mcpUrl, serverName)].filter(Boolean).join("\n\n"));
      } catch (error) {
        emit({ type: "error", runId: spec.runId, ts: now(), message: error instanceof Error ? error.message : String(error), fatal: true });
        stopProcess(proc);
      }
    })();

    return handle;
  }

  private get version(): string {
    return this.options.clientVersion ?? "0.0.0";
  }

  /** The agent offers named options; the app's decision picks the one whose kind matches. */
  private requestPermission(
    runId: string,
    params: RequestPermissionRequest,
    pending: Map<string, (response: RequestPermissionResponse) => void>,
    emit: (ev: AgentEvent) => void,
  ): Promise<RequestPermissionResponse> {
    const approvalId = randomUUID();
    const kind = approvalKindFor(params.toolCall.kind ?? null);
    const toolName = params.toolCall.name ?? toolNameForKind(params.toolCall.kind ?? null);
    const input = params.toolCall.rawInput ?? {};
    const detail = params.toolCall.title ?? toolName;
    return new Promise<RequestPermissionResponse>((resolve) => {
      const respond = (response: RequestPermissionResponse) => {
        pending.delete(approvalId);
        resolve(response);
      };
      pending.set(approvalId, respond);
      void this.options.onApproval({ runId, approvalId, kind, toolName, detail, input }).then(
        (answer) => {
          const decision = typeof answer === "string" ? answer : answer.decision;
          const option = optionKindsFor[decision].map((kind) => params.options.find((candidate) => candidate.kind === kind)).find(Boolean);
          respond(option ? { outcome: { outcome: "selected", optionId: option.optionId } } : cancelledOutcome);
          emit({ type: "approval.resolved", runId, ts: Date.now(), approvalId, decision });
        },
        () => respond(cancelledOutcome),
      );
    });
  }
}

/** The agent's own wording, except for the refusals a user can act on. */
function promptFailure(error: unknown, model: string | undefined): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/model unavailable/i.test(message)) {
    const name = model ?? message.replace(/^.*model unavailable:\s*/i, "");
    return `OpenCode reports ${name} is unavailable. Check the model ID, provider configuration and account access, or choose another model. Provider detail: ${message}`;
  }
  return message;
}

function streamOf(proc: ChildProcess) {
  return ndJsonStream(Writable.toWeb(proc.stdin!) as WritableStream<Uint8Array>, Readable.toWeb(proc.stdout!) as ReadableStream<Uint8Array>);
}

function approvalKindFor(kind: string | null): ApprovalKind {
  if (kind === "execute") return "command";
  if (kind === "edit" || kind === "delete" || kind === "move") return "file_change";
  return "tool";
}

function toolNameForKind(kind: string | null): string {
  if (kind === "execute") return "shell";
  return kind ?? "tool";
}

/** The `model` option lists every model the agent can run and which one is current. */
export function modelsFrom(options: SessionConfigOption[] | null | undefined): Omit<AcpModel, "efforts" | "defaultEffort">[] {
  const option = options?.find((candidate) => candidate.id === "model");
  if (!option || option.type !== "select") return [];
  // Options come flat or grouped by provider; either way each entry is one model.
  const entries = option.options.flatMap((entry) => ("options" in entry ? entry.options : [entry]));
  return entries.map((entry) => {
    const slash = entry.value.indexOf("/");
    const providerId = slash === -1 ? entry.value : entry.value.slice(0, slash);
    const labelSlash = entry.name.indexOf("/");
    const providerLabel = labelSlash === -1 ? providerId : entry.name.slice(0, labelSlash);
    const label = labelSlash === -1 ? entry.name : entry.name.slice(labelSlash + 1);
    return { id: entry.value, label, provider: { id: providerId, label: providerLabel }, isDefault: entry.value === option.currentValue };
  });
}

function currentModel(options: SessionConfigOption[] | null | undefined): string | null {
  const option = options?.find((candidate) => candidate.id === "model");
  return option?.type === "select" ? option.currentValue : null;
}

/** Pictures go in as image blocks; other files are named for the agent to open. */
async function promptBlocks(text: string, attachments: string[] | undefined, appendix: string | undefined): Promise<ContentBlock[]> {
  const { images, files } = partitionAttachments(attachments);
  const blocks: ContentBlock[] = [];
  // ACP has no system prompt channel, so the app's brief travels ahead of the first message.
  if (appendix) blocks.push({ type: "text", text: appendix });
  blocks.push({ type: "text", text: withAttachedFiles(text, files, "open them to read") });
  for (const path of images) {
    blocks.push({ type: "image", mimeType: imageMimeTypes[extname(path).toLowerCase()] ?? "image/png", data: await readFile(path, { encoding: "base64" }) });
  }
  return blocks;
}

function usageFor(usage: AcpUsage | null | undefined, context: ContextReport | null): Usage | undefined {
  if (!usage && !context) return undefined;
  return {
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
    ...(usage?.cachedReadTokens ? { cacheReadTokens: usage.cachedReadTokens } : {}),
    ...(usage?.cachedWriteTokens ? { cacheWriteTokens: usage.cachedWriteTokens } : {}),
    ...(context?.costUsd !== undefined ? { costUsd: context.costUsd } : {}),
    ...(context ? { contextTokens: context.used, contextWindow: context.size } : {}),
  };
}
