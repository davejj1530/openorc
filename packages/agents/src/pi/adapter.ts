import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { AgentEvent, RunSpec, Usage } from "@openorc/protocol";
import { partitionAttachments, withAttachedFiles } from "../attachments.js";
import type { AgentLaunchEnvironment } from "../launch-environment.js";
import { RunHandle, LiveInputUnavailable } from "../run-handle.js";
import { emitProviderFailure, providerErrorActivity } from "../provider-errors.js";
import { piBridge } from "./bridge.js";
import { PiEvents, piUsage } from "./events.js";
import { PiDialogs, type PiApproval } from "./interactions.js";
import { listPiModels, piState } from "./models.js";
import { PiRpc, type PiEvent } from "./rpc.js";
import { applyPiSettings } from "./settings.js";

const imageMime: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
const promptAnswer = z.object({ disposition: z.enum(["started", "queued", "handled"]) });
type Turn = { id: string; startedAt: number; cancelled: boolean };

async function promptInput(text: string, attachments?: string[]): Promise<Record<string, unknown>> {
  const { images, files } = partitionAttachments(attachments);
  return {
    message: withAttachedFiles(text, files, "open them to read"),
    images: await Promise.all(images.map(async (file) => ({ type: "image", data: (await readFile(file)).toString("base64"), mimeType: imageMime[path.extname(file).toLowerCase()] }))),
  };
}

function startProcess(spec: RunSpec, launch: AgentLaunchEnvironment, nonce: string) {
  if (launch.host) throw new Error("Pi currently runs on the connected computer. Cloud execution is not supported yet.");
  if (spec.strictMcp) throw new Error("Pi cannot isolate the user's MCP servers yet. Use another agent for this operation.");
  const directory = mkdtempSync(path.join(os.tmpdir(), "openorc-pi-"));
  try {
    const extension = path.join(directory, "openorc.mjs");
    writeFileSync(extension, piBridge(spec, nonce), { mode: 0o600 });
    const args = ["--mode", "rpc", "--offline", spec.untrustedCheckout ? "--no-approve" : "--approve", "--no-extensions", "-e", "builtin:mcp", "-e", extension];
    if (spec.resumeSessionId) args.push(spec.forkSession ? "--fork" : "--session", spec.resumeSessionId);
    if (!spec.resumeSessionId || spec.forkSession) args.push("--session-id", randomUUID());
    if (spec.model) args.push("--model", spec.model);
    if (spec.effort) args.push("--thinking", spec.effort);
    if (spec.systemPromptAppendix) args.push("--append-system-prompt", spec.systemPromptAppendix);
    return { rpc: new PiRpc(launch, spec.cwd, args), directory };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

/** Drives the installed Pi CLI through its native RPC transport. */
export class PiAdapter {
  constructor(private readonly options: { onApproval: PiApproval }) {}

  listModels(launch: AgentLaunchEnvironment) {
    return listPiModels(launch);
  }

  start(spec: RunSpec, launch: AgentLaunchEnvironment): RunHandle {
    return new PiSession(spec, launch, this.options.onApproval).handle;
  }
}

class PiSession {
  readonly handle: RunHandle;
  private readonly rpc: PiRpc;
  private readonly directory: string;
  private readonly mapper: PiEvents;
  private readonly dialogs: PiDialogs;
  private readonly startedAt = Date.now();
  private closed = false;
  private ready = false;
  private turns = 0;
  private turn: Turn | null = null;
  private settling: Promise<void> = Promise.resolve();
  private failure: string | null = null;
  private changingSettings = false;
  private manualCompaction = false;

  constructor(
    private readonly spec: RunSpec,
    launch: AgentLaunchEnvironment,
    onApproval: PiApproval,
  ) {
    const nonce = randomUUID();
    const started = startProcess(spec, launch, nonce);
    this.rpc = started.rpc;
    this.directory = started.directory;
    this.mapper = new PiEvents(spec.runId);
    this.dialogs = new PiDialogs(spec.runId, nonce, this.rpc, onApproval, (event) => this.emit(event));
    this.rpc.on("event", (event) => this.receive(event));
    this.rpc.on("failure", (error) => this.fail(error));
    this.handle = new RunHandle(spec.runId, {
      done: this.rpc.done.then((code) => this.exited(code)),
      send: (text, attachments) => this.send(text, attachments),
      close: () => this.close(),
      interrupt: () => this.interrupt(),
      canSteer: () => this.canSteer(),
      steer: (text, attachments) => this.steer(text, attachments),
      compacting: () => this.mapper.compacting || this.manualCompaction,
      applySettings: async (settings) => {
        if (!this.ready || this.closed || this.failure) throw new Error("Pi is not ready to change settings.");
        if (this.turn || this.mapper.compacting || this.manualCompaction || this.changingSettings) throw new Error("Wait for Pi to finish before changing its settings.");
        this.changingSettings = true;
        try {
          await applyPiSettings(this.rpc, settings);
        } finally {
          this.changingSettings = false;
        }
      },
      compact: async () => {
        if (this.turn || this.mapper.compacting || this.manualCompaction || this.changingSettings) throw new Error("Wait for Pi to finish before compacting.");
        this.manualCompaction = true;
        try {
          await this.rpc.request("compact", {}, 300_000);
        } finally {
          this.manualCompaction = false;
        }
      },
    });
    void this.initialize().catch((error) => this.fail(error));
  }

  private emit(event: AgentEvent): void {
    this.handle.emit("event", event);
  }

  private async initialize(): Promise<void> {
    const state = piState.parse(await this.rpc.request("get_state"));
    if (!this.dialogs.ready) throw new Error("Pi did not load OpenOrc's permission bridge. Install Pi 1.5.0 or newer and try again.");
    if (!state.model) throw new Error("Pi has no available models. Run pi and use /login to connect a provider, or configure an API key.");
    if (this.closed) return;
    this.ready = true;
    this.emit({ type: "session.started", runId: this.spec.runId, ts: Date.now(), agent: "pi", externalSessionId: state.sessionId, model: `${state.model.provider}/${state.model.id}` });
    await this.send(this.spec.prompt, this.spec.attachments);
  }

  private receive(event: PiEvent): void {
    if (this.closed || this.failure) return;
    try {
      if (event.type === "extension_ui_request") {
        void this.dialogs.answer(event).catch((error) => this.fail(error));
        return;
      }
      for (const mapped of this.mapper.map(event)) this.emit(mapped);
      if (event.type === "agent_settled" && this.turn) {
        this.turn.cancelled ||= event["aborted"] === true;
        this.settling = this.finish(this.turn);
      }
    } catch (error) {
      this.fail(error);
    }
  }

  private async finish(ended: Turn, error?: string): Promise<void> {
    if (this.turn !== ended) return;
    let usage: Usage | undefined;
    if (!this.closed) {
      try {
        usage = piUsage(await this.rpc.request("get_session_stats"));
        const state = piState.parse(await this.rpc.request("get_state"));
        if (state.model) usage.model = `${state.model.provider}/${state.model.id}`;
      } catch {
        /* Usage is optional; a completed response still settles. */
      }
    }
    if (this.turn !== ended) return;
    this.turn = null;
    this.turns++;
    const message = error ?? this.mapper.error;
    let status: "cancelled" | "error" | "success" = message ? "error" : "success";
    if (ended.cancelled || this.mapper.aborted) status = "cancelled";
    const base = { runId: this.spec.runId, ts: Date.now() };
    if (message && status === "error") this.emit(providerErrorActivity(this.spec.runId, "pi", `error-${ended.id}`, message));
    if (usage) this.emit({ ...base, type: "usage.updated", usage });
    this.emit({ ...base, type: "turn.completed", turnId: ended.id, status, resultText: this.mapper.text, ...(usage ? { usage } : {}), durationMs: Date.now() - ended.startedAt });
  }

  private fail(error: unknown): void {
    if (this.failure || this.closed) return;
    this.failure = error instanceof Error ? error.message : String(error);
    emitProviderFailure((event) => this.emit(event), this.spec.runId, "pi", error);
    this.dialogs.cancel();
    this.rpc.close();
  }

  private async send(text: string, attachments?: string[]): Promise<void> {
    if (this.turn && (await this.steer(text, attachments)) === "accepted") return;
    this.assertCanPrompt();
    const input = await promptInput(text, attachments);
    this.assertCanPrompt();
    const started = { id: randomUUID(), startedAt: Date.now(), cancelled: false };
    this.mapper.begin();
    this.turn = started;
    this.emit({ type: "turn.started", runId: this.spec.runId, ts: started.startedAt, turnId: started.id });
    try {
      const result = promptAnswer.parse(await this.rpc.request("prompt", input));
      if (result.disposition === "handled") this.settling = this.finish(started);
    } catch (error) {
      // A missing acknowledgement is ambiguous: fence the process before any replacement turn can write.
      this.fail(error);
      throw error;
    }
  }

  private assertCanPrompt(): void {
    if (!this.ready || this.closed || this.failure) throw new Error("Pi is not ready to receive a message.");
    if (this.turn || this.mapper.compacting || this.manualCompaction || this.changingSettings) throw new LiveInputUnavailable("Pi is still working. Wait for it to finish.");
  }

  private async exited(code: number | null): Promise<number | null> {
    this.closed = true;
    this.dialogs.cancel();
    await this.settling;
    if (this.turn) await this.finish(this.turn, this.failure ?? "Pi exited before completing the response.");
    rmSync(this.directory, { recursive: true, force: true });
    this.emit({
      type: "session.completed",
      runId: this.spec.runId,
      ts: Date.now(),
      status: this.failure || (code !== 0 && code !== null) ? "error" : "success",
      turns: this.turns,
      durationMs: Date.now() - this.startedAt,
    });
    this.handle.emit("exit", code);
    return code;
  }

  private close(): void {
    if (this.turn) this.turn.cancelled = true;
    this.dialogs.cancel();
    this.closed = true;
    this.rpc.close();
  }

  private async interrupt(): Promise<void> {
    const turn = this.turn;
    this.dialogs.cancel();
    await this.rpc.request("clear_queue");
    await this.rpc.request("abort");
    if (turn) turn.cancelled = true;
  }

  private canSteer(): boolean {
    return this.ready && !this.closed && !this.failure && Boolean(this.turn) && !this.mapper.compacting && !this.dialogs.pending;
  }

  private async steer(text: string, attachments?: string[]): Promise<"accepted" | "unavailable"> {
    if (!this.canSteer()) return "unavailable";
    const turn = this.turn;
    const input = await promptInput(text, attachments);
    if (!this.canSteer() || this.turn !== turn) return "unavailable";
    try {
      await this.rpc.request("steer", input);
    } catch (error) {
      this.fail(error);
      throw error;
    }
    return "accepted";
  }
}
