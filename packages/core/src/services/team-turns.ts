import type { TeamAttemptRecord, TeamExecutionRecord } from "@openorc/protocol";
import type { RunService } from "./runs.js";

/**
 * What this process has in flight for team turns, beside the durable journal: turns being launched, turns being
 * settled, live input being delivered, and member sessions kept open between turns. Every "is anything still
 * writing?" question is answered here from the same facts, so no caller combines them its own way.
 */
export class TeamTurns {
  private readonly launches = new Map<string, { executionId: string; promise: Promise<void> }>();
  private readonly settlements = new Map<string, Promise<void>>();
  /** Live input per provider run, delivered one at a time. */
  private readonly deliveries = new Map<string, Promise<void>>();
  /** Processes deliberately kept open between a member's turns, as opposed to ones that have not finished closing. */
  private readonly warm = new Set<string>();

  constructor(private readonly runs: Pick<RunService, "isLive" | "isBusy">) {}

  launching(attemptId: string, executionId: string, promise: Promise<void>): void {
    this.launches.set(attemptId, { executionId, promise });
  }
  launched(attemptId: string): void {
    this.launches.delete(attemptId);
  }
  isLaunching(attemptId: string): boolean {
    return this.launches.has(attemptId);
  }

  /** Starts recording a turn's settlement unless one is already running for it; returns the new settlement, if any. */
  settle(attemptId: string, start: () => Promise<void>): Promise<void> | null {
    if (this.settlements.has(attemptId)) return null;
    const settlement = start();
    this.settlements.set(attemptId, settlement);
    return settlement;
  }
  settled(attemptId: string): void {
    this.settlements.delete(attemptId);
  }
  isSettling(attemptId: string): boolean {
    return this.settlements.has(attemptId);
  }

  delivering(runId: string, promise: Promise<void>): void {
    this.deliveries.set(runId, promise);
  }
  delivered(runId: string): void {
    this.deliveries.delete(runId);
  }
  /** The live input still on its way into this run, if any. */
  delivery(runId: string): Promise<void> | undefined {
    return this.deliveries.get(runId);
  }

  keepWarm(runId: string): void {
    this.warm.add(runId);
  }
  /** The process is answering again, is being replaced, or is going away: it is no longer idle and warm. */
  cool(runId: string): void {
    this.warm.delete(runId);
  }
  coolAll(): void {
    this.warm.clear();
  }
  isWarm(runId: string): boolean {
    return this.warm.has(runId);
  }
  /** Warm member sessions of these turns that are open and idle right now, and may be closed. */
  idleWarm(attempts: readonly TeamAttemptRecord[]): string[] {
    return [...new Set(attempts.flatMap((attempt) => (attempt.runId ? [attempt.runId] : [])))].filter((runId) => this.warm.has(runId) && this.runs.isLive(runId) && !this.runs.isBusy(runId));
  }

  /** Whether this turn still has a writer: being launched or settled, delivering live input, or a live process. */
  writing(attempt: TeamAttemptRecord): boolean {
    return this.launches.has(attempt.id) || this.settlements.has(attempt.id) || Boolean(attempt.runId && (this.runs.isLive(attempt.runId) || this.deliveries.has(attempt.runId)));
  }
  /** Whether a launch of this execution is still being prepared. */
  launchingIn(executionId: string): boolean {
    return [...this.launches.values()].some((launch) => launch.executionId === executionId);
  }
  /**
   * Whether this turn holds one of the team's inference slots. A warm idle session holds none; a closing writer still
   * does. A process serves several turns of a member, so only its latest turn is counted.
   */
  occupies(attempt: TeamAttemptRecord, latestOnRun: ReadonlyMap<string, string>): boolean {
    return (
      this.launches.has(attempt.id) ||
      ["starting", "running"].includes(attempt.state) ||
      Boolean(attempt.runId && latestOnRun.get(attempt.runId) === attempt.id && this.runs.isLive(attempt.runId) && !this.warm.has(attempt.runId))
    );
  }

  /** What a stop of this execution waits for, besides closing its processes. */
  barriers(record: TeamExecutionRecord): Promise<void>[] {
    const runs = new Set(record.attempts.flatMap((attempt) => (attempt.runId ? [attempt.runId] : [])));
    return [
      ...[...this.launches.values()].filter((launch) => launch.executionId === record.id).map((launch) => launch.promise),
      ...[...runs].flatMap((runId) => (this.deliveries.has(runId) ? [this.deliveries.get(runId)!] : [])),
      ...record.attempts.flatMap((attempt) => (this.settlements.has(attempt.id) ? [this.settlements.get(attempt.id)!] : [])),
    ];
  }
  /** Everything in flight, for shutdown. */
  all(): Promise<void>[] {
    return [...[...this.launches.values()].map((launch) => launch.promise), ...this.deliveries.values()];
  }
}
