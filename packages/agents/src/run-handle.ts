import { EventEmitter } from "node:events";
import type { AgentEvent, McpAppConnection } from "@openorc/protocol";

export interface RunHandleEvents {
  event: [AgentEvent];
  exit: [number | null];
}

/** Settings a live session can take between turns. An omitted key leaves that setting alone. */
export interface LiveSettings {
  model?: string;
  effort?: string;
  fastMode?: boolean;
}

export interface RunControls {
  mcpApps?: McpAppConnection;
  /** Stop the current turn, or between turns the background work it left running; resolve after transport acceptance, or reject on failure. */
  interrupt: () => void | Promise<void>;
  /** End the process. */
  close: () => void;
  /** Send a follow-up prompt on the same session, where the agent supports it. */
  send: (text: string, attachments?: string[]) => Promise<void>;
  /** Stop one command the agent left running in the background, such as a dev server. One that already ended is left alone. */
  stopCommand?: (commandId: string) => Promise<void>;
  /** Live input only: unavailable proves no input was sent; errors may be ambiguous. */
  steer?: (text: string, attachments?: string[]) => Promise<"accepted" | "unavailable">;
  /** Dynamic provider readiness. A live process can be between turns or compacting. */
  canSteer?: () => boolean;
  compacting?: () => boolean;
  /** Ask the agent to fold the conversation so far into a summary, where the agent supports it. */
  compact?: () => Promise<void>;
  /** Change the model, effort or speed of the open session between turns, where the agent supports it. Rejects when it cannot; the caller restarts instead. */
  applySettings?: (settings: LiveSettings) => Promise<void>;
  done: Promise<number | null>;
}

/** What the core holds for a live agent process, whatever the vendor. */
export class RunHandle extends EventEmitter<RunHandleEvents> {
  private closed = false;
  constructor(
    readonly runId: string,
    private readonly controls: RunControls,
  ) {
    super();
    void controls.done.then(
      () => {
        this.closed = true;
      },
      () => {
        this.closed = true;
      },
    );
  }
  async interrupt(): Promise<void> {
    await this.controls.interrupt();
  }
  close(): void {
    this.closed = true;
    this.controls.close();
  }
  send(text: string, attachments?: string[]): Promise<void> {
    return this.controls.send(text, attachments);
  }
  /** Only agents that report background commands can stop one. */
  stopCommand(commandId: string): Promise<void> {
    if (!this.controls.stopCommand) return Promise.reject(new Error("this agent cannot stop a background command"));
    return this.controls.stopCommand(commandId);
  }
  get compacting(): boolean {
    return this.controls.compacting?.() ?? false;
  }
  get canSteer(): boolean {
    return !this.closed && Boolean(this.controls.steer) && (this.controls.canSteer?.() ?? true);
  }
  /** Never starts another turn, resumes a session or waits for compaction. */
  steer(text: string, attachments?: string[]): Promise<"accepted" | "unavailable"> {
    if (!this.canSteer) return Promise.resolve("unavailable");
    return this.controls.steer!(text, attachments);
  }
  get canCompact(): boolean {
    return Boolean(this.controls.compact);
  }
  get mcpApps(): McpAppConnection | undefined {
    return this.closed ? undefined : this.controls.mcpApps;
  }
  compact(): Promise<void> {
    if (!this.controls.compact) return Promise.reject(new Error("this agent cannot compact a live session"));
    return this.controls.compact();
  }
  get canApplySettings(): boolean {
    return !this.closed && Boolean(this.controls.applySettings);
  }
  /** Never starts a turn. A rejection means the session still runs with its old settings. */
  applySettings(settings: LiveSettings): Promise<void> {
    if (!this.canApplySettings) return Promise.reject(new Error("this agent cannot change settings on a live session"));
    return this.controls.applySettings!(settings);
  }
  wait(): Promise<number | null> {
    return this.controls.done;
  }
  /** Resolve on the next event of a given type. Handy for spikes and tests. */
  next<T extends AgentEvent["type"]>(type: T, timeoutMs = 120_000): Promise<Extract<AgentEvent, { type: T }>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off("event", listener);
        reject(new Error(`timed out waiting for ${type}`));
      }, timeoutMs);
      const listener = (ev: AgentEvent) => {
        if (ev.type === type) {
          clearTimeout(timer);
          this.off("event", listener);
          resolve(ev as Extract<AgentEvent, { type: T }>);
        }
      };
      this.on("event", listener);
    });
  }
}
