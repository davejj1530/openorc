import { projects, threads, type Db } from "@openorc/db";
import { run } from "@openorc/git";
import type { PrState } from "@openorc/protocol";
import type { Logger } from "../transport.js";
import type { ThreadService } from "./threads.js";

/** Snoozes end and PR badges refresh; conversations never complete automatically. */
export class LifecycleService {
  private timer: NodeJS.Timeout | null = null;
  private ticks = 0;

  constructor(
    private readonly db: Db,
    private readonly threads: ThreadService,
    private readonly invalidate: (keys: string[]) => void,
    private readonly log: Logger,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), 60_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    this.ticks += 1;
    try {
      this.wakeSnoozed();
      if (this.ticks % 5 === 1) await this.pollPullRequests();
    } catch (e) {
      this.log.warn(`lifecycle tick failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private wakeSnoozed(): void {
    for (const t of threads.dueFromSnooze(this.db, Date.now())) {
      if (this.threads.teamQuiescenceReason(t.id)) continue;
      threads.update(this.db, t.id, { snoozedUntil: null });
      this.invalidate(["threads", `thread:${t.id}`]);
    }
  }

  /** A merge updates the badge without putting away the conversation. */
  async pollPullRequests(): Promise<void> {
    for (const t of threads.withOpenPr(this.db)) {
      const project = projects.get(this.db, t.projectId);
      if (!project || !t.prUrl) continue;
      const state = await this.prState(project.rootPath, t.prUrl);
      if (!state || state === t.prState) continue;
      const fresh = threads.get(this.db, t.id);
      if (!fresh || fresh.prUrl !== t.prUrl || fresh.prState !== t.prState) continue;
      threads.update(this.db, t.id, { prState: state });
      this.invalidate(["threads", `thread:${t.id}`]);
    }
  }

  private async prState(cwd: string, url: string): Promise<PrState | null> {
    try {
      const result = await run("gh", cwd, ["pr", "view", url, "--json", "state"], { timeoutMs: 20_000 });
      const payload: unknown = JSON.parse(result.stdout);
      if (!payload || typeof payload !== "object" || !("state" in payload) || typeof payload.state !== "string") return null;
      const state = payload.state.toLowerCase();
      if (state === "merged" || state === "closed" || state === "open") return state;
      return null;
    } catch {
      return null;
    }
  }
}
