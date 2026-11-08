import { spawnAgentProcess } from "../process-recovery.js";
import { executionMode, executionModeUnavailable } from "@openorc/protocol";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";
import { extname } from "node:path";
import readline from "node:readline";
import { Readable, Writable } from "node:stream";
import {
  client,
  ndJsonStream,
  PROTOCOL_VERSION,
  type ClientCapabilities,
  type ContentBlock,
  type InitializeResponse,
  type McpServer,
  type NewSessionRequest,
  type PermissionOptionKind,
  type PromptResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionConfigOption,
  type Usage as AcpUsage,
} from "@agentclientprotocol/sdk";
import type { AgentEvent, ApprovalDecision, ApprovalKind, ApprovalResolution, RunSpec, Usage } from "@openorc/protocol";
import { definedEnv, launchPlace, type AgentHost, type LaunchPlace } from "../agent-host.js";
import { agentBinary } from "../bin.js";
import { emitProviderFailure, providerErrorActivity } from "../provider-errors.js";
import { launchCommand } from "../command-launch.js";
import { inFolder, type AgentLaunchEnvironment } from "../launch-environment.js";
import { partitionAttachments, withAttachedFiles } from "../attachments.js";
import { stopProcess, waitForProcessGroup } from "../process-lifetime.js";
import { RunHandle, LiveInputUnavailable, type RunControls } from "../run-handle.js";
import { stripAnsi } from "../jsonrpc.js";
import { AcpUpdateMapper, type ContextReport } from "./updates.js";
import { AcpSubagents, childUpdate } from "./subagents.js";
import { agentCommand, SubagentSpend } from "./subagent-spend.js";
import { questionInstructions } from "./questions.js";
import { answerForm, AutoCompactions, type FormRun, type PendingRequest } from "./forms.js";
import type { AcpProfile, AcpRunContext, AgentCommand } from "./profile.js";
import { openCodeAcp } from "../opencode/acp.js";
import { readModels } from "./models.js";
import { acpControl } from "./control.js";
import { promptOutcome } from "./outcome.js";
import { AcpSettings, selectedModel, setModelOption } from "./settings.js";
export { modelsFrom } from "./models.js";
import { cursorPlan, cursorQuestion, answerCursorQuestion, presentCursorPlan } from "../cursor/interactions.js";
import { CursorTodos, cursorTodos } from "../cursor/todos.js";

/** A permission the agent asked for, in the app's terms. The host announces it and answers it. */
export interface AcpApprovalRequest {
  runId: string;
  approvalId: string;
  kind: ApprovalKind;
  toolName: string;
  detail: string;
  input: unknown;
  /** The agent offered no option that keeps allowing this, so it can only be allowed once. */
  onceOnly: boolean;
  subagentId?: string;
}

export interface AcpAdapterOptions {
  /** Which agent: OpenCode unless told. */
  profile?: AcpProfile;
  binary?: string;
  env?: NodeJS.ProcessEnv;
  mcpServerName?: string;
  clientVersion?: string;
  /** Where a throwaway session is opened to read the model list. Defaults to the home directory. */
  modelsCwd?: string;
  /** Resolves tool permission requests through OpenOrc's approval policy. */
  onApproval: (request: AcpApprovalRequest) => Promise<ApprovalDecision | ApprovalResolution>;
  /** Reads the agent's models some other way than a throwaway session's model option. */
  listModels?: (launch: AgentLaunchEnvironment) => Promise<AcpModel[]>;
  /** Runs the agent's command line for reads beside a session, such as its subagents' cost, some other way than a process of its own. */
  runCommand?: AgentCommand;
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

type Connection = ReturnType<ReturnType<typeof client>["connect"]>;

async function setSessionOption(connection: Connection, sessionId: string | null, profile: AcpProfile, configId: string, value: string): Promise<SessionConfigOption[] | null | undefined> {
  if (!sessionId) throw new Error(`${profile.name} has no session yet.`);
  const set = async (configId: string, value: string) =>
    (
      await acpControl(
        profile.name,
        () => connection.agent.request("session/set_config_option", { sessionId, configId, value }),
        () => connection.close(),
      )
    ).configOptions;
  return configId === "model" ? setModelOption(value, profile, set) : set(configId, value);
}

/** Says what OpenOrc handles; answers whether the agent takes a message into a running turn. */
async function initialize(connection: Connection, profile: AcpProfile, version: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  return acpControl(
    profile.name,
    async () => {
      const clientCapabilities: ClientCapabilities = { fs: { readTextFile: false, writeTextFile: false }, terminal: false };
      if (profile.elicitation) clientCapabilities.elicitation = { form: {} };
      if (profile.clientMeta) clientCapabilities._meta = profile.clientMeta;
      const initialized = await connection.agent.request<InitializeResponse>("initialize", { protocolVersion: PROTOCOL_VERSION, clientCapabilities, clientInfo: clientInfo(version) });
      const methodId = typeof profile.authMethod === "function" ? profile.authMethod(env) : profile.authMethod;
      if (methodId) await connection.agent.request("authenticate", { methodId });
      return steers(initialized._meta);
    },
    () => connection.close(),
  );
}

/** The run's session: a fork of the one it resumes, that one itself, or a new one. */
async function openSession(connection: Connection, spec: RunSpec, mcpServers: McpServer[], profile: AcpProfile): Promise<{ sessionId: string; options: SessionConfigOption[] | null | undefined }> {
  return acpControl(
    profile.name,
    async () => {
      const params: NewSessionRequest = { cwd: spec.cwd, mcpServers, ...(profile.sessionMeta ? { _meta: profile.sessionMeta(spec) } : {}) };
      if (spec.resumeSessionId && spec.forkSession) {
        const forked = await connection.agent.request("session/fork", { sessionId: spec.resumeSessionId, ...params });
        return { sessionId: forked.sessionId, options: forked.configOptions };
      }
      if (spec.resumeSessionId) {
        const resumed = await connection.agent.request(profile.loadSession ? "session/load" : "session/resume", { sessionId: spec.resumeSessionId, ...params });
        return { sessionId: spec.resumeSessionId, options: resumed.configOptions };
      }
      const created = await connection.agent.request("session/new", params);
      return { sessionId: created.sessionId, options: created.configOptions };
    },
    () => connection.close(),
  );
}

/** Through the agent's own way in: pictures as files where it runs, uploaded first for a host; other files named in the text. */
async function steerOwnWay(
  steerVia: NonNullable<AcpProfile["steer"]>,
  command: AgentCommand,
  sessionId: string,
  text: string,
  attachments: string[] | undefined,
  host: AgentHost | undefined,
): Promise<"accepted" | "unavailable"> {
  const { images, files } = partitionAttachments(attachments);
  const [pictures, named] = host ? await Promise.all([images.length ? host.upload(images) : images, files.length ? host.upload(files) : files]) : [images, files];
  return steerVia(command, sessionId, withAttachedFiles(text, named, "open them to read"), pictures);
}

/** The agent folds the message into the turn it is running, or says a prompt is needed, having taken nothing. */
async function steer(connection: Connection, sessionId: string, prompt: ContentBlock[], profile: AcpProfile): Promise<"accepted" | "unavailable"> {
  if (profile.promptSteering) {
    if (profile.textOnlySteering && prompt.some((block) => block.type !== "text")) return "unavailable";
    const response = await connection.agent.request("session/prompt", { sessionId, prompt, ...(profile.steeringMeta ? { _meta: profile.steeringMeta } : {}) });
    return profile.steeringOutcome?.(response) ?? "accepted";
  }
  const answer = await connection.agent.request<{ outcome?: unknown; reason?: unknown }>("_session/steering", { sessionId, prompt });
  if (answer?.outcome === "injected") return "accepted";
  if (answer?.outcome === "failed") throw new Error(typeof answer.reason === "string" && answer.reason ? answer.reason : `${profile.name} did not take the message.`);
  return "unavailable";
}

/**
 * The turn that handed its plan over is stopped once the answer to it is on its way: the agent would otherwise be told
 * to keep refining and propose again. One that ended meanwhile is left alone.
 */
function stopAfterPlan<T extends { planShown?: boolean }>(planning: T | null, current: () => T | null, cancel: () => void): void {
  if (planning) planning.planShown = true;
  setImmediate(() => {
    if (planning && current() === planning) cancel();
  });
}

/** The agent's own /compact, run as a turn of its own that resolves when the summary is in place. */
function compactAsTurn(
  runId: string,
  activityId: string,
  emit: (event: AgentEvent) => void,
  prompt: (maintenance: { activityId: string; resolve: () => void; reject: (error: Error) => void }) => Promise<void>,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    emit({ type: "activity.updated", runId, ts: Date.now(), activityId, label: "Compacting context", status: "running", detail: { mode: "manual" } });
    prompt({ activityId, resolve, reject }).catch((error: unknown) => {
      emit({ type: "activity.updated", runId, ts: Date.now(), activityId, label: "Compacting context", status: "error" });
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

/** The user's servers beside OpenOrc's; a broken saved configuration must be reported rather than silently omitted. */
async function sessionServers(profile: AcpProfile, context: AcpRunContext, own: McpServer[], env: NodeJS.ProcessEnv): Promise<McpServer[]> {
  if (context.host || !profile.userServers) return own;
  return [...own, ...(await profile.userServers(env)).filter((server) => server.name !== context.serverName)];
}

/** A prompt in flight, including a maintenance turn or a plan awaiting handover. */
interface AcpTurn {
  id: string;
  startedAt: number;
  maintenance: { activityId: string; resolve: () => void; reject: (error: Error) => void } | null;
  planShown?: boolean;
  /** The answer is kept while the subagents' cost is read. */
  answer?: PromptResponse;
}

/** Resolve a maintenance request only after its activity has a final state. */
function finishMaintenance(maintenance: NonNullable<AcpTurn["maintenance"]>, ok: boolean, message: string | null, runId: string, ts: number, emit: (event: AgentEvent) => void): void {
  emit({ type: "activity.updated", runId, ts, activityId: maintenance.activityId, label: "Compacting context", status: ok ? "success" : "error", ...(message ? { text: message } : {}) });
  if (ok) maintenance.resolve();
  else maintenance.reject(new Error(message ?? "Context compaction did not finish. Your draft has not been sent."));
}

/** Only offer compaction when the agent has a native command for it. */
function compactionControls(
  profile: AcpProfile,
  runId: string,
  current: () => AcpTurn | null,
  emit: (event: AgentEvent) => void,
  prompt: (text: string, attachments: string[] | undefined, appendix?: string, maintenance?: AcpTurn["maintenance"]) => Promise<void>,
): Pick<RunControls, "compact"> {
  if (profile.compactCommand === null) return {};
  let count = 0;
  return {
    compact: () => {
      const turn = current();
      if (turn?.maintenance) return Promise.resolve();
      if (turn) return Promise.reject(new Error("Wait for the current turn to finish before compacting."));
      return compactAsTurn(runId, `manual-compaction-${++count}`, emit, (maintenance) => prompt(profile.compactCommand ?? "/compact", undefined, undefined, maintenance));
    },
  };
}

/** Which option kinds satisfy each app decision, best first. */
const optionKindsFor: Record<ApprovalDecision, readonly PermissionOptionKind[]> = {
  allow: ["allow_once", "allow_always"],
  allow_for_run: ["allow_always", "allow_once"],
  deny: ["reject_once", "reject_always"],
};

function observeProcess(proc: ReturnType<typeof spawnAgentProcess>, runId: string, emit: (event: AgentEvent) => void, closing: () => boolean): void {
  proc.once("exit", () => {
    try {
      stopProcess(proc);
    } catch (error) {
      emit({ type: "error", runId: runId, ts: Date.now(), message: `Process cleanup needs attention: ${error instanceof Error ? error.message : String(error)}`, fatal: false });
    }
  });
  proc.on("error", (error) => {
    emit({ type: "error", runId: runId, ts: Date.now(), message: error.message, fatal: true });
    // A binary that could not be spawned never exits; end the run here so it does not stay live forever.
    if (!proc.pid) proc.emit("exit", null, null);
  });
  readline.createInterface({ input: proc.stderr, crlfDelay: Infinity }).on("line", (line) => {
    // What the agent says on its way out once told to stop, as how to resume the session, is not a problem.
    if (closing() || !line.trim()) return;
    emit({ type: "error", runId: runId, ts: Date.now(), message: stripAnsi(line), fatal: false });
  });
}

const cancelledOutcome: RequestPermissionResponse = { outcome: { outcome: "cancelled" } };
type PendingPermission = PendingRequest;

const clientInfo = (version: string) => ({ name: "openorc", title: "OpenOrc", version });

/** OpenOrc's tools, at the address that reaches them from where the agent runs: on a host, such as a cloud sandbox, the host's. */
function toolsAddress(spec: RunSpec, host: AgentHost | undefined): string | undefined {
  const own = spec.internalMcp?.url ?? spec.mcpUrl;
  return own && host ? host.localUrl(own) : own;
}

/** The agent's ACP process, on its host when the run has one, as the Codex adapter starts its own. */
function acpProcess(launch: AgentLaunchEnvironment, spec: RunSpec, place: LaunchPlace, args: string[], env: NodeJS.ProcessEnv, cwd = spec.cwd) {
  if (launch.host) return launch.host.spawn(launch.binary, args, { runId: spec.runId, cwd, env: definedEnv(env), files: place.files, dirs: place.dirs });
  return spawnAgentProcess(launch.binary, args, { cwd, env, registry: launch.processRegistry });
}

/** An extension notification's parameters, read as a plain object. */
const notice = (value: unknown): Record<string, unknown> => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

/** The path and text of a plan file a tool call writes, as Oh My Pi's agent writes its plan in Plan mode. */
function planWrite(update: { rawInput?: unknown }): string | null {
  const input = update.rawInput && typeof update.rawInput === "object" ? (update.rawInput as Record<string, unknown>) : null;
  if (!input || typeof input["path"] !== "string" || typeof input["content"] !== "string") return null;
  return /-plan\.md$|(^|\/)PLAN\.md$/.test(input["path"]) ? input["content"] : null;
}

/** Whether the agent takes a message into a running turn, as `initialize` says. Claude's and Codex's ACP adapters say it the same way. */
function steers(meta: unknown): boolean {
  const steering = meta && typeof meta === "object" ? (meta as Record<string, unknown>)["steering"] : undefined;
  return Boolean(steering && typeof steering === "object" && (steering as Record<string, unknown>)["supported"] === true);
}

/**
 * Drives an agent that speaks the Agent Client Protocol over stdio: OpenCode and Oh My Pi, each through its profile;
 * the protocol is the same for any other. The agent keeps its own session store, so a run is one process holding one
 * session, prompted once per turn.
 */
export class AcpAdapter {
  private readonly profile: AcpProfile;

  constructor(private readonly options: AcpAdapterOptions) {
    this.profile = options.profile ?? openCodeAcp;
  }

  /** Models the installed agent can run, read from the configuration a throwaway session reports. */
  async listModels(launch?: AgentLaunchEnvironment): Promise<AcpModel[]> {
    const binary = launch?.binary ?? this.options.binary ?? agentBinary(this.profile.agent);
    if (this.options.listModels) return this.options.listModels(launch ?? { revision: 0, binary, env: { ...process.env, ...this.options.env } });
    const env = launch ? { ...launch.env, ...this.options.env } : { ...process.env, ...this.options.env };
    await this.profile.checkReady?.(launch ?? { revision: 0, binary, env });
    const cwd = this.options.modelsCwd ?? env["HOME"] ?? os.homedir();
    const command = launchCommand(binary, ["acp"]);
    const proc = spawn(command.file, command.args, { ...command.options, cwd, env: inFolder(env, cwd), stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" });
    const closed = new Promise<void>((resolve) => proc.once("close", () => resolve()));
    proc.stderr.resume();
    const connection = client({ name: "openorc" }).connect(streamOf(proc));
    proc.once("error", () => connection.close());
    const timeout = setTimeout(() => {
      connection.close();
      stopProcess(proc);
    }, 30_000);
    let sessionId: string | undefined;
    try {
      await initialize(connection, this.profile, this.version, env);
      const created = await connection.agent.request("session/new", { cwd, mcpServers: [] });
      sessionId = created.sessionId;
      return await readModels(connection, this.profile, created.configOptions, sessionId);
    } finally {
      // Also delete after a failed capability query; discovery never sends a prompt.
      if (sessionId) await connection.agent.request("session/delete", { sessionId }).catch(() => undefined);
      connection.close();
      stopProcess(proc);
      await closed;
      await waitForProcessGroup(proc);
      clearTimeout(timeout);
    }
  }

  start(spec: RunSpec, launch: AgentLaunchEnvironment): RunHandle {
    const unavailable = executionModeUnavailable(spec.agent, executionMode(spec.mode ?? "act", spec.permissionMode));
    if (unavailable) throw new Error(unavailable);
    const { profile } = this;
    const name = profile.name;
    const host = launch.host;
    const serverName = spec.internalMcp?.serverName ?? this.options.mcpServerName ?? "openorc";
    const mcpUrl = toolsAddress(spec, host);
    const ownServers: McpServer[] = mcpUrl && !profile.ownServerInLaunch ? [{ type: "http", name: serverName, url: mcpUrl, headers: [] }] : [];
    const askUser = Boolean(mcpUrl && spec.internalMcp?.toolNames.includes("ask_user"));
    const place = launchPlace(host);
    const context: AcpRunContext = { host, place, mcpUrl, serverName, askUser };
    const { args, env, cwd: processCwd, privateDir } = profile.launch(spec, { ...launch.env, ...this.options.env }, context);
    const startedAt = Date.now();
    const proc = acpProcess(launch, spec, place, args, env, processCwd);
    const mapper = new AcpUpdateMapper(spec.runId);
    let handle: RunHandle;
    let sessionId: string | null = null;
    let turn: AcpTurn | null = null;
    /** The text of the plan file the agent last wrote whole, for when its file cannot be read here. */
    let lastPlan: string | null = null;
    let turns = 0;
    /** The agent said in `initialize` that it takes a message into a running turn. */
    let steering = false;
    /** OpenOrc ended the process itself. */
    let closing = false;
    /** Permission requests the agent is waiting on; a cancelled turn answers them all. */
    const pendingPermissions = new Map<string, PendingPermission>();
    const emit = (ev: AgentEvent) => handle.emit("event", ev);
    const now = () => Date.now();
    const exited = () => proc.exitCode !== null || proc.signalCode !== null;
    const subagents = trackChildren(spec.runId, () => sessionId, emit, pendingPermissions);
    const autoCompactions = new AutoCompactions(spec.runId, () => sessionId, emit);
    const todos = new CursorTodos(spec.runId);
    const forms: FormRun = {
      runId: spec.runId,
      agentName: name,
      planning: spec.mode === "plan",
      session: () => sessionId,
      pending: pendingPermissions,
      ask: (request) => this.options.onApproval(request),
      emit,
      planText: async () => (!host && sessionId && profile.planText ? await profile.planText(sessionId, env) : null) ?? lastPlan,
      planShown: () =>
        stopAfterPlan(
          turn,
          () => turn,
          () => void (sessionId && connection.agent.notify("session/cancel", { sessionId }).catch(() => undefined)),
        ),
    };
    const command = this.options.runCommand ?? agentCommand(launch, spec.runId, env);
    const subagentSpend = new SubagentSpend(profile.subagentCosts?.(command), Boolean(spec.resumeSessionId && !spec.forkSession));

    const app = client({ name: "openorc" })
      .onNotification("session/update", ({ params }) => {
        // Replayed history and child sessions belong to other transcripts.
        if (!sessionId || params.sessionId !== sessionId) return;
        emit({ type: "raw", runId: spec.runId, ts: now(), agent: profile.agent, payload: params.update });
        if (params.update.sessionUpdate === "usage_update" && params.update.cost) subagentSpend.reported();
        if (subagents.legacy(params.update, now())) {
          subagentSpend.seen();
          return;
        }
        subagents.observe(sessionId, params.update, now());
        if (params.update.sessionUpdate === "tool_call" || params.update.sessionUpdate === "tool_call_update") lastPlan = planWrite(params.update) ?? lastPlan;
        for (const ev of mapper.map(params.update, now())) emit(ev);
      })
      .onNotification("_omp/compaction/start", notice, ({ params }) => autoCompactions.started(params))
      .onNotification("_omp/compaction/end", notice, ({ params }) => autoCompactions.ended(params))
      .onNotification(
        "cursor/update_todos",
        (value) => cursorTodos.parse(value),
        ({ params }) => {
          if (sessionId) emit(todos.update(params));
        },
      )
      .onNotification("opencode/session/child_update", childUpdate, ({ params }) => {
        emit({ type: "raw", runId: spec.runId, ts: now(), agent: profile.agent, payload: { method: "opencode/session/child_update", params } });
        if (params.rootSessionId === sessionId) subagentSpend.seen();
        subagents.route(params, now());
      })
      .onRequest("session/request_permission", ({ params }) => this.requestPermission(spec.runId, params, pendingPermissions, emit, subagents.permissionSession(params.sessionId)))
      .onRequest("elicitation/create", ({ params }) => answerForm(params, forms))
      .onRequest(
        "cursor/ask_question",
        (value) => cursorQuestion.parse(value),
        ({ params }) => answerCursorQuestion(params, forms),
      )
      .onRequest(
        "cursor/create_plan",
        (value) => cursorPlan.parse(value),
        ({ params }) => presentCursorPlan(params, forms),
      );
    const connection = app.connect(streamOf(proc));

    const settle = (id: string, response: PromptResponse | null, error?: unknown, subagentCostUsd = subagentSpend.last): void => {
      if (!turn || turn.id !== id) return;
      const { startedAt: turnStartedAt, maintenance, planShown } = turn;
      turn = null;
      subagents.endParentTurn(now());
      const ended = mapper.endTurn(now());
      for (const ev of ended.events) emit(ev);
      const outcome = promptOutcome(profile, response, error, ended.text, planShown, settings.model ?? spec.model);
      if (maintenance) {
        finishMaintenance(maintenance, outcome.status === "success", outcome.message, spec.runId, now(), emit);
        return;
      }
      // Keep the failure reason in the conversation transcript.
      if (outcome.message) emit(providerErrorActivity(spec.runId, profile.agent, `error-${id}`, outcome.error, outcome.message));
      const usage = usageFor(response?.usage, ended.context, subagentCostUsd, settings.model ?? spec.model);
      if (usage) emit({ type: "usage.updated", runId: spec.runId, ts: now(), usage });
      turns += 1;
      emit({
        type: "turn.completed",
        runId: spec.runId,
        ts: now(),
        turnId: id,
        status: outcome.status,
        ...(ended.text ? { resultText: ended.text } : {}),
        ...(usage ? { usage } : {}),
        durationMs: now() - turnStartedAt,
      });
    };

    const settings = new AcpSettings(
      profile,
      (configId, value) => setSessionOption(connection, sessionId, profile, configId, value),
      () => stopProcess(proc),
    );

    /**
     * A message can join the running turn when the agent says it takes one. Not while it waits on an approval: Oh My Pi
     * drops the request then, and the card would stay open over nothing, so the message waits in the queue instead.
     */
    const canSteer = () =>
      steering &&
      Boolean(sessionId && turn && !turn.maintenance) &&
      !exited() &&
      !autoCompactions.active &&
      !mapper.compacting &&
      ![...pendingPermissions.values()].some((pending) => pending.sessionId === sessionId);
    /** Into the running turn: the agent's own way when its ACP server has none, else the protocol extension it offers. */
    const steerNow = async (text: string, attachments: string[] | undefined): Promise<"accepted" | "unavailable"> => {
      if (!canSteer() || !sessionId) return "unavailable";
      if (profile.steer) return steerOwnWay(profile.steer, command, sessionId, text, attachments, host);
      const current = turn;
      const blocks = await promptBlocks(text, attachments, host, undefined);
      return turn === current && canSteer() ? steer(connection, sessionId, blocks, profile) : "unavailable";
    };

    /** One prompt is one turn. The agent answers the request when the turn ends, so nothing else may prompt meanwhile. */
    const prompt = async (text: string, attachments: string[] | undefined, appendix?: string, maintenance?: NonNullable<typeof turn>["maintenance"]): Promise<void> => {
      if (!sessionId) throw new Error(`${name} has no session yet.`);
      if (exited()) throw new Error(`The ${name} process is no longer running.`);
      if (turn || settings.busy) throw new LiveInputUnavailable(`${name} is still answering or changing settings. Wait for it to finish.`);
      const blocks = await promptBlocks(text, attachments, host, [appendix, askUser && !profile.elicitation ? questionInstructions(serverName) : undefined].filter(Boolean).join("\n\n") || undefined);
      if (turn || settings.busy || exited()) throw new Error(`${name} cannot start another turn right now.`);
      const id = randomUUID();
      turn = { id, startedAt: now(), maintenance: maintenance ?? null };
      subagentSpend.turnStarted();
      if (!maintenance) emit({ type: "turn.started", runId: spec.runId, ts: now(), turnId: id });
      void connection.agent.request("session/prompt", { sessionId, prompt: blocks }).then(
        async (response) => {
          const answered = turn?.id === id ? turn : null;
          if (answered) answered.answer = response;
          settle(id, response, undefined, await subagentSpend.afterTurn(answered && !answered.maintenance && !exited() ? sessionId : null));
        },
        (error: unknown) => settle(id, null, error),
      );
    };

    const done = new Promise<number | null>((resolve) => {
      proc.on("close", async (code) => {
        await waitForProcessGroup(proc);
        if (privateDir) place.remove(privateDir);
        connection.close();
        subagents.close(now());
        // A turn the agent had answered, its subagents' cost still being read, ended as it answered.
        if (turn) settle(turn.id, turn.answer ?? null, turn.answer ? undefined : new Error(`${name} exited before the turn finished.`));
        // Oh My Pi exits with the signal's code when stopped; a stop OpenOrc asked for is a clean end.
        const stopped = closing && (code === 128 + 15 || code === 128 + 2);
        emit({ type: "session.completed", runId: spec.runId, ts: now(), status: code === 0 || code === null || stopped ? "success" : "error", durationMs: now() - startedAt, turns });
        handle.emit("exit", code);
        resolve(code);
      });
    });

    handle = new RunHandle(spec.runId, {
      interrupt: async () => {
        if (!sessionId || (!turn && !autoCompactions.active && !mapper.compacting) || exited()) return;
        // The protocol requires every open permission request to be answered as cancelled first.
        for (const pending of [...pendingPermissions.values()]) if (pending.sessionId === sessionId) pending.cancel();
        await connection.agent.notify("session/cancel", { sessionId });
      },
      close: () => {
        closing = true;
        stopProcess(proc);
      },
      canStopSubagent: (id) => !exited() && subagents.canStop(id),
      stopSubagent: async (id) => {
        for (const pending of [...pendingPermissions.values()]) if (pending.sessionId === id) pending.cancel();
        await connection.agent.notify("session/cancel", { sessionId: id });
        subagents.cancelled(id, now());
      },
      // Steer the running turn when supported; otherwise prompt rejects until it finishes.
      send: async (text, attachments) => {
        if (turn && (await steerNow(text, attachments)) === "accepted") return;
        await prompt(text, attachments);
      },
      canSteer: () => canSteer(),
      steer: (text, attachments) => steerNow(text, attachments),
      // The same options the session was opened with, changed in place; the next prompt uses them.
      applySettings: async (change) => {
        if (turn || autoCompactions.active || mapper.compacting) throw new Error("Wait for the current turn to finish before changing its settings.");
        if (exited()) throw new Error(`The ${name} process is no longer running.`);
        await settings.apply(change);
      },
      compacting: () => Boolean(turn?.maintenance) || autoCompactions.active || mapper.compacting,
      ...compactionControls(profile, spec.runId, () => turn, emit, prompt),
      done,
    });

    observeProcess(proc, spec.runId, emit, () => closing);

    void (async () => {
      try {
        await profile.checkReady?.({ ...launch, env }, spec.cwd);
        steering = (await initialize(connection, profile, this.version, env)) || Boolean(profile.steer || profile.promptSteering);
        const opened = await openSession(connection, spec, await sessionServers(profile, context, ownServers, env), profile);
        sessionId = opened.sessionId;
        const options = await settings.initialize(opened.options, spec);
        emit({ type: "session.started", runId: spec.runId, ts: now(), agent: profile.agent, externalSessionId: sessionId, model: selectedModel(options, profile) ?? spec.model ?? null });
        await prompt(spec.prompt, spec.attachments, [spec.systemPromptAppendix, profile.briefing(spec, context)].filter(Boolean).join("\n\n"));
      } catch (error) {
        emitProviderFailure(emit, spec.runId, profile.agent, error);
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
    pending: Map<string, PendingPermission>,
    emit: (ev: AgentEvent) => void,
    subagentId?: string | false,
  ): Promise<RequestPermissionResponse> {
    if (subagentId === false) return Promise.resolve(cancelledOutcome);
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
      pending.set(approvalId, { sessionId: params.sessionId, cancel: () => respond(cancelledOutcome) });
      const onceOnly = !params.options.some((option) => option.kind === "allow_always");
      void this.options.onApproval({ runId, approvalId, kind, toolName, detail, input, onceOnly, ...(subagentId ? { subagentId } : {}) }).then(
        (answer) => {
          if (!pending.has(approvalId)) return;
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

/** Images travel inline from this Mac; other files are named by path, so a host gets copies and the text names those. */
async function promptBlocks(text: string, attachments: string[] | undefined, host: AgentHost | undefined, appendix: string | undefined): Promise<ContentBlock[]> {
  const { images, files } = partitionAttachments(attachments);
  const named = host && files.length ? await host.upload(files) : files;
  const blocks: ContentBlock[] = [];
  // ACP has no system prompt channel, so the app's brief travels ahead of the first message.
  if (appendix) blocks.push({ type: "text", text: appendix });
  blocks.push({ type: "text", text: withAttachedFiles(text, named, "open them to read") });
  for (const path of images) {
    blocks.push({ type: "image", mimeType: imageMimeTypes[extname(path).toLowerCase()] ?? "image/png", data: await readFile(path, { encoding: "base64" }) });
  }
  return blocks;
}

/** The turn's usage; the session's cost includes its subagents' when the agent reports them apart. */
function usageFor(usage: AcpUsage | null | undefined, context: ContextReport | null, subagentCostUsd: number, model?: string): Usage | undefined {
  if (!usage && !context) return undefined;
  return {
    ...(model ? { model } : {}),
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
    ...(usage?.cachedReadTokens ? { cacheReadTokens: usage.cachedReadTokens } : {}),
    ...(usage?.cachedWriteTokens ? { cacheWriteTokens: usage.cachedWriteTokens } : {}),
    ...(context?.costUsd !== undefined ? { costUsd: context.costUsd + subagentCostUsd } : {}),
    ...(context ? { contextTokens: context.used, contextWindow: context.size } : {}),
  };
}

function trackChildren(runId: string, root: () => string | null, emit: (event: AgentEvent) => void, pending: Map<string, PendingPermission>): AcpSubagents {
  return new AcpSubagents(runId, root, emit, (id) => {
    for (const [approvalId, request] of [...pending])
      if (request.sessionId === id) {
        request.cancel();
        emit({ type: "approval.resolved", runId, ts: Date.now(), approvalId, decision: "deny" });
      }
  });
}
