import os from "node:os";
import { definedEnv } from "../agent-host.js";
import type { AgentLaunchEnvironment } from "../launch-environment.js";
import { stopProcess } from "../process-lifetime.js";
import { spawnAgentProcess } from "../process-recovery.js";
import type { AgentCommand } from "./profile.js";

/** A read beside the session is given up after this long, and the turn ends without it. */
const READ_TIMEOUT_MS = 10_000;

/**
 * The agent's command line, run once for a read beside a run's session: where the session is, on its host when it has
 * one, and in its home folder, so no project's own settings load.
 */
export function agentCommand(launch: AgentLaunchEnvironment, runId: string, env: NodeJS.ProcessEnv): AgentCommand {
  let reads = 0;
  return (args) =>
    new Promise<string>((resolve, reject) => {
      const host = launch.host;
      const proc = host
        ? host.spawn(launch.binary, args, { runId: `${runId}-read-${++reads}`, cwd: host.home, env: definedEnv(env), files: [], dirs: [] })
        : spawnAgentProcess(launch.binary, args, { cwd: os.homedir(), env });
      const out: Buffer[] = [];
      const timer = setTimeout(() => stopProcess(proc), READ_TIMEOUT_MS);
      proc.stdout.on("data", (chunk: Buffer) => out.push(chunk));
      proc.stderr.resume();
      proc.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      proc.once("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(Buffer.concat(out).toString("utf8"));
        else reject(new Error(`${args.slice(0, 3).join(" ")} exited with ${String(code)}`));
      });
    });
}

/**
 * What a session's subagents have cost, for an agent whose own report counts the session alone. It is read again as a
 * turn that reported the session's cost ends, while the session has had subagents: in this process, or before it in a
 * resumed session until a read finds none. A read that fails keeps the last one.
 */
export class SubagentSpend {
  private seenHere = false;
  private reportedThisTurn = false;
  private cost = 0;

  constructor(
    private readonly read: ((sessionId: string) => Promise<number>) | undefined,
    private earlier: boolean,
  ) {}

  /** What the subagents had cost at the last read. */
  get last(): number {
    return this.cost;
  }

  /** A subagent ran in the session. */
  seen(): void {
    this.seenHere = true;
  }

  /** The turn reported the session's own cost. */
  reported(): void {
    this.reportedThisTurn = true;
  }

  turnStarted(): void {
    this.reportedThisTurn = false;
  }

  /** The cost to add as the turn ends; `sessionId` is null when the turn is not one to read for. */
  async afterTurn(sessionId: string | null): Promise<number> {
    const due = this.reportedThisTurn;
    this.reportedThisTurn = false;
    if (!this.read || !sessionId || !due || !(this.seenHere || this.earlier)) return this.cost;
    this.cost = await this.read(sessionId).catch(() => this.cost);
    if (!this.cost) this.earlier = false;
    return this.cost;
  }
}
