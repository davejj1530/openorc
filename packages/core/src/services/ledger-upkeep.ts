import { statfsSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { ledgerMaintenance, settings, type Db } from "@openorc/db";
import type { Logger } from "../transport.js";
import type { ToolImageStore } from "./tool-images.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const MB = 1024 * 1024;
/** Rows deleted per step; each step holds the single writer for a few milliseconds. */
const EXPIRE_BATCH = 500;
const RUNS_PER_QUERY = 50;
/** Free pages handed back to the disk per step. */
const RECLAIM_PAGES = 256;
const SWEEP_KEY = "ledger.fragmentSweep";
const COMPACTION_FAILED_KEY = "ledger.compactionFailedAt";
/** How long a failed rebuild waits before the next launch tries again. */
const COMPACTION_RETRY_MS = 3 * DAY_MS;

/**
 * The one full rebuild runs on its own connection in a worker thread, so the core's event loop stays free to tell a
 * window that connects meanwhile what it is waiting for. The truncating checkpoint returns the copy the rebuild wrote
 * to the WAL.
 */
const COMPACT = `
const { workerData } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(workerData.file);
try {
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA auto_vacuum = INCREMENTAL");
  db.exec("VACUUM");
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
} finally {
  db.close();
}
`;

export interface LedgerUpkeepOptions {
  log: Logger;
  /** Image folders of runs that are gone are removed on every pass. */
  toolImages?: ToolImageStore;
  /** Native rows older than this are deleted. */
  rawRetentionMs?: number;
  /** The first pass waits this long after startup; later passes follow every `intervalMs`. */
  startDelayMs?: number;
  intervalMs?: number;
  /** Awaited between steps so the core answers the window while a pass works through a large ledger. */
  pause?: () => Promise<void>;
  now?: () => number;
}

/**
 * Keeps the ledger's size in check in the background: expires native rows, clears streaming fragments that
 * history written before the ledger dropped them still holds, and hands free space back to the disk.
 */
export class LedgerUpkeep {
  private timer: NodeJS.Timeout | null = null;
  private pass: Promise<void> | null = null;
  private stopped = false;
  private readonly rawRetentionMs: number;
  private readonly startDelayMs: number;
  private readonly intervalMs: number;
  private readonly pause: () => Promise<void>;
  private readonly now: () => number;

  constructor(
    private readonly db: Db,
    private readonly options: LedgerUpkeepOptions,
  ) {
    this.rawRetentionMs = options.rawRetentionMs ?? 14 * DAY_MS;
    this.startDelayMs = options.startDelayMs ?? 60_000;
    this.intervalMs = options.intervalMs ?? 6 * 60 * 60 * 1000;
    this.pause = options.pause ?? (() => new Promise((resolve) => setTimeout(resolve, 25)));
    this.now = options.now ?? Date.now;
  }

  /**
   * Whether the file in `dir` is worth the one full rebuild, and the disk has room for it: it cannot yet hand free
   * space back a little at a time, and a quarter of it or more is free. Files created since the ledger turned
   * incremental vacuuming on never are.
   */
  static needsCompaction(db: Db, dir: string, now = Date.now()): boolean {
    const space = ledgerMaintenance.space(db);
    if (space.incremental || space.freeBytes < 64 * MB || space.freeBytes < space.fileBytes / 4) return false;
    if (now - Number(settings.get(db, COMPACTION_FAILED_KEY) ?? 0) < COMPACTION_RETRY_MS) return false;
    // The rebuild writes the pages it keeps twice, to a temporary file and through the WAL, before the file shrinks.
    const disk = statfsSync(dir);
    return disk.bavail * disk.bsize > 2 * (space.fileBytes - space.freeBytes) + 256 * MB;
  }

  /**
   * Rebuilds `db`'s file without its free space, on a connection of its own. Nothing may write to it until this
   * settles. A failure is remembered, so the next launches skip the rebuild for a while.
   */
  static async compact(db: Db, file: string): Promise<void> {
    try {
      await new Promise<void>((resolve, reject) => {
        const worker = new Worker(COMPACT, { eval: true, workerData: { file } });
        worker.once("error", reject);
        worker.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`ledger compaction exited with code ${code}`))));
      });
    } catch (error) {
      settings.set(db, COMPACTION_FAILED_KEY, String(Date.now()));
      throw error;
    }
  }

  start(): void {
    const schedule = (delay: number) => {
      this.timer = setTimeout(() => {
        this.pass = this.run().finally(() => {
          this.pass = null;
          if (!this.stopped) schedule(this.intervalMs);
        });
      }, delay);
      this.timer.unref();
    };
    schedule(this.startDelayMs);
  }

  /** Stops scheduling and waits out a pass in progress, which ends at its next step. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.pass;
  }

  /** One pass; exposed for tests. Each step runs even when an earlier one fails. */
  async run(): Promise<void> {
    const step = async (name: string, work: () => Promise<number>): Promise<number> => {
      try {
        return await work();
      } catch (error) {
        this.options.log.warn(`ledger upkeep could not ${name}: ${error instanceof Error ? error.message : String(error)}`);
        return 0;
      }
    };
    const expired = await step("expire native rows", () => this.expireRaw());
    const cleared = await step("clear fragments", () => this.sweepFragments());
    const reclaimed = await step("return free space", () => this.reclaim());
    const forgotten = await step("clean up deleted runs", () => this.forgetDeletedRuns());
    if (expired || cleared || reclaimed || forgotten) {
      this.options.log.info(
        `ledger upkeep: expired ${expired} native rows, cleared ${cleared} fragments, returned ${Math.round(reclaimed / MB)} MB to the disk, removed what ${forgotten} deleted runs left behind`,
      );
    }
  }

  /**
   * Removes what deleted runs leave outside the rows that cascade with them, whichever way their thread, task or
   * team went: search entries and stored tool images. Returns how many runs' images went.
   */
  async forgetDeletedRuns(): Promise<number> {
    ledgerMaintenance.clearDeletedRunSearch(this.db);
    return (await this.options.toolImages?.prune((runId) => this.db.stmt("SELECT 1 FROM runs WHERE id = ?").get(runId) !== undefined)) ?? 0;
  }

  private async expireRaw(): Promise<number> {
    const before = this.now() - this.rawRetentionMs;
    let total = 0;
    while (!this.stopped) {
      const deleted = ledgerMaintenance.expireRaw(this.db, before, EXPIRE_BATCH);
      total += deleted;
      if (deleted < EXPIRE_BATCH) break;
      await this.pause();
    }
    return total;
  }

  /**
   * Clears fragments run by run, oldest first, remembering the last run done so a restart picks up there. Runs
   * still open are skipped: this version's ledger writer settles their fragments as their items finish, and the
   * core ends any run left open by an earlier one before upkeep starts. Once every run is done it never runs again.
   */
  private async sweepFragments(): Promise<number> {
    const marker = settings.get(this.db, SWEEP_KEY);
    if (marker === "done") return 0;
    let after = marker ? (JSON.parse(marker) as { startedAt: number; id: string }) : { startedAt: -1, id: "" };
    let total = 0;
    while (!this.stopped) {
      const page = this.db
        .stmt("SELECT id, started_at AS startedAt, state FROM runs WHERE (started_at, id) > (?, ?) ORDER BY started_at, id LIMIT ?")
        .all(after.startedAt, after.id, RUNS_PER_QUERY) as Array<{ id: string; startedAt: number; state: string }>;
      for (const run of page) {
        if (this.stopped) return total;
        if (run.state !== "starting" && run.state !== "running") total += ledgerMaintenance.clearSupersededFragments(this.db, run.id);
        after = { startedAt: run.startedAt, id: run.id };
        settings.set(this.db, SWEEP_KEY, JSON.stringify(after));
        await this.pause();
      }
      if (page.length < RUNS_PER_QUERY) {
        settings.set(this.db, SWEEP_KEY, "done");
        break;
      }
    }
    return total;
  }

  /** Returns bytes handed back. A file that is not yet incremental keeps its free pages for new rows instead. */
  private async reclaim(): Promise<number> {
    const { pageBytes } = ledgerMaintenance.space(this.db);
    let pages = 0;
    while (!this.stopped) {
      const freed = ledgerMaintenance.reclaim(this.db, RECLAIM_PAGES);
      pages += freed;
      if (freed < RECLAIM_PAGES) break;
      await this.pause();
    }
    return pages * pageBytes;
  }
}
