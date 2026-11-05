import { createHash } from "node:crypto";
import { memoryChangesSince, settings, tasks, type Db, type MemoryChanges } from "@openorc/db";
import type { MemoryChoice, MemoryExchangeProject, RpcMethod, RpcParams, RpcResults, TaskStatus } from "@openorc/protocol";
import type { Logger } from "../transport.js";
import type { ProjectMapping } from "./brain-link.js";
import type { MemoryService } from "./memory.js";
import type { TextGenerationService } from "./text-generation.js";

const CURSORS = "brain.memory";
/** Pages one exchange takes at most, each up to 2000 rows a side: far past any project's memory. */
const MAX_ROUNDS = 50;
/** The tasks a backlog shows: not done, not archived. */
export const OPEN_TASKS: TaskStatus[] = ["proposed", "backlog", "in_progress", "review"];

/** Where each side's last read of a project's memory ended, on its own clock, for one copy on the brain. */
interface Cursor {
  copy: string;
  sent: number;
  heard: number;
}

export interface BrainSyncDeps {
  db: Db;
  memory: Pick<MemoryService, "choice" | "merge">;
  textGeneration: Pick<TextGenerationService, "choice">;
  /** A call to the brain that never wakes it. */
  call<M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<RpcResults[M]>;
  mapping(): Promise<ProjectMapping>;
  log: Logger;
}

/**
 * What the Mac and its cloud brain keep of each other's work while both are awake: each project's memory, merged both
 * ways, and the Mac's open tasks, which the brain keeps read-only for phones while the Mac sleeps. Only projects the
 * brain has a copy of. The brain also follows the Mac's choice of who names conversations. Driven on the project
 * copies' schedule; never wakes the brain.
 */
export class BrainSync {
  /** The brain may have changed its memory since the last exchange: it did not answer since the link came up, or it said so. */
  private brainChanged = true;
  /** What the brain last took of the Mac's open tasks, by print; null until it took any on this link. */
  private backlogSent: string | null = null;
  /** The memory choices the brain last took, by print; null until it took any on this link. */
  private choiceSent: string | null = null;
  /** The text generation choice the brain last took, by print; null until it took one on this link. */
  private textSent: string | null = null;
  private warned = false;

  constructor(private readonly deps: BrainSyncDeps) {}

  /** The link came up: the brain may have changed, or be another, so everything is told again. */
  relinked(): void {
    this.brainChanged = true;
    this.backlogSent = null;
    this.choiceSent = null;
    this.textSent = null;
    this.warned = false;
  }

  /** The brain said its memory changed. */
  brainTouched(): void {
    this.brainChanged = true;
  }

  async exchange(): Promise<void> {
    try {
      const pairs = (await this.deps.mapping()).pairs ?? [];
      await this.memory(pairs);
      await this.backlog(pairs);
      await this.textGeneration();
    } catch (error) {
      // A brain from before these requests refuses them on every exchange; once a link is enough to say so.
      if (!this.warned) this.deps.log.warn(`the cloud brain did not take this Mac's memory, tasks and choices: ${error instanceof Error ? error.message : String(error)}`);
      this.warned = true;
    }
  }

  private cursors(): Record<string, Cursor> {
    try {
      return JSON.parse(settings.get(this.deps.db, CURSORS) ?? "{}") as Record<string, Cursor>;
    } catch {
      return {};
    }
  }

  private async memory(pairs: readonly { mac: string; cloud: string }[]): Promise<void> {
    const choice = this.deps.memory.choice();
    const { enabled } = choice;
    const print = JSON.stringify(choice);
    const cursors = this.cursors();
    const at = (pair: { mac: string; cloud: string }) => (cursors[pair.mac]?.copy === pair.cloud ? cursors[pair.mac]! : { copy: pair.cloud, sent: 0, heard: 0 });
    const brainChanged = this.brainChanged;
    this.brainChanged = false;
    // After a page, the projects either side left rows of go again at once, so one exchange brings them all.
    let left: Set<string> | null = null;
    for (let round = 0; round < MAX_ROUNDS && (left === null || left.size > 0); round++) {
      const again = left;
      const sending = enabled
        ? pairs.flatMap((pair) => {
            if (again && !again.has(pair.mac)) return [];
            const cursor = at(pair);
            const up = memoryChangesSince(this.deps.db, pair.mac, cursor.sent);
            const fresh = cursors[pair.mac]?.copy !== pair.cloud;
            return again || up.rows.length || up.removed.length || brainChanged || fresh ? [{ pair, cursor, up }] : [];
          })
        : [];
      if (!sending.length && this.choiceSent === print) return;
      let answer: { projects: MemoryExchangeProject[] };
      try {
        answer = await this.deps.call("brain.memory.exchange", {
          ...choice,
          projects: sending.map(({ pair, cursor, up }) => ({ projectId: pair.cloud, since: cursor.heard, rows: up.rows, removed: up.removed })),
        });
      } catch (error) {
        this.brainChanged ||= brainChanged || again !== null;
        throw error;
      }
      this.choiceSent = print;
      left = new Set();
      for (const { pair, cursor, up } of sending) {
        const heard = answer.projects.find((project) => project.projectId === pair.cloud);
        if (!heard) continue;
        const last = await this.take(choice, pair, cursor, heard);
        cursors[pair.mac] = { copy: pair.cloud, sent: up.next, heard: last.next };
        settings.set(this.deps.db, CURSORS, JSON.stringify(cursors));
        if (up.more || last.more) left.add(pair.mac);
      }
    }
  }

  /**
   * The brain's changes taken here. Rows here that beat the brain's, which it may never have had, go up at once, so both
   * copies agree before the cursors move. Answers the brain's last answer, which says where its next read starts.
   */
  private async take(choice: MemoryChoice, pair: { mac: string; cloud: string }, cursor: Cursor, heard: MemoryExchangeProject): Promise<MemoryExchangeProject> {
    const { kept } = this.deps.memory.merge(pair.mac, changes(heard));
    if (!kept.length) return heard;
    const again = await this.deps.call("brain.memory.exchange", { ...choice, projects: [{ projectId: pair.cloud, since: cursor.heard, rows: kept, removed: [] }] });
    const last = again.projects.find((project) => project.projectId === pair.cloud);
    if (!last) return heard;
    this.deps.memory.merge(pair.mac, changes(last));
    return last;
  }

  /** The Mac's open tasks of projects the brain has, on the brain's projects, sent when they changed. */
  private async backlog(pairs: readonly { mac: string; cloud: string }[]): Promise<void> {
    const cloudOf = new Map(pairs.map((pair) => [pair.mac, pair.cloud]));
    const open = tasks.list(this.deps.db, { statuses: OPEN_TASKS }).flatMap((task) => {
      const cloud = cloudOf.get(task.projectId);
      return cloud ? [{ ...task, projectId: cloud, worktreePath: null }] : [];
    });
    const print = createHash("sha256").update(JSON.stringify(open)).digest("base64url");
    if (print === this.backlogSent) return;
    await this.deps.call("brain.backlog", { at: Date.now(), tasks: open });
    this.backlogSent = print;
  }

  /** Last, so a brain from before this request still takes the memory and the tasks. */
  private async textGeneration(): Promise<void> {
    const choice = this.deps.textGeneration.choice();
    const print = JSON.stringify(choice);
    if (print === this.textSent) return;
    await this.deps.call("brain.textGeneration", choice);
    this.textSent = print;
  }
}

const changes = ({ rows, removed }: MemoryExchangeProject): MemoryChanges => ({ rows, removed });
