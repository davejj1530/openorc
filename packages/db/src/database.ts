import { DatabaseSync, type StatementSync } from "node:sqlite";
import * as sqliteVec from "sqlite-vec";
import { migrations } from "./schema.js";

/**
 * One connection, one writer. node:sqlite is synchronous, which is what a
 * single-writer ledger wants: no lock starvation across await points.
 */
export class Db {
  private readonly statements = new Map<string, StatementSync>();
  private readonly rollbackListeners = new Set<() => void>();
  private transactionSequence = 0;
  /** True when sqlite-vec loaded and the vector table exists; retrieval degrades to FTS otherwise. */
  hasVectors = false;

  constructor(readonly raw: DatabaseSync) {}

  static open(file: string): Db {
    const raw = new DatabaseSync(file, { allowExtension: true });
    // Takes effect only on a new, empty file; an existing one switches at its next full rebuild.
    raw.exec("PRAGMA auto_vacuum = INCREMENTAL");
    raw.exec("PRAGMA journal_mode = WAL");
    raw.exec("PRAGMA synchronous = NORMAL");
    raw.exec("PRAGMA busy_timeout = 5000");
    raw.exec("PRAGMA foreign_keys = ON");
    const db = new Db(raw);
    db.loadVectors();
    db.migrate();
    return db;
  }

  static memory(): Db {
    const raw = new DatabaseSync(":memory:", { allowExtension: true });
    raw.exec("PRAGMA foreign_keys = ON");
    const db = new Db(raw);
    db.loadVectors();
    db.migrate();
    return db;
  }

  /**
   * Vector search is an enhancement, never a dependency. If the extension is
   * missing on this platform, memory still works on full-text search alone.
   */
  private loadVectors(): void {
    try {
      const extension = sqliteVec.getLoadablePath();
      // SQLite's native loader cannot read Electron's virtual archive paths.
      // The desktop package keeps this library beside app.asar on disk.
      this.raw.loadExtension(process.versions.electron ? extension.replace(/\.asar([/\\])/, ".asar.unpacked$1") : extension);
      this.raw.exec("CREATE VIRTUAL TABLE IF NOT EXISTS memory_vec USING vec0(memory_rowid INTEGER PRIMARY KEY, embedding FLOAT[384])");
      this.hasVectors = true;
    } catch {
      this.hasVectors = false;
    }
  }

  /** Prepared statements are cached by SQL text. */
  stmt(sql: string): StatementSync {
    let s = this.statements.get(sql);
    if (!s) {
      s = this.raw.prepare(sql);
      this.statements.set(sql, s);
    }
    return s;
  }

  transaction<T>(fn: () => T): T {
    // SAVEPOINT starts a transaction when none is open and composes with repository
    // transactions during atomic admission. Only the outermost release commits.
    const name = `openorc_tx_${++this.transactionSequence}`;
    this.raw.exec(`SAVEPOINT ${name}`);
    try {
      const result = fn();
      this.raw.exec(`RELEASE SAVEPOINT ${name}`);
      return result;
    } catch (e) {
      this.raw.exec(`ROLLBACK TO SAVEPOINT ${name}`);
      this.raw.exec(`RELEASE SAVEPOINT ${name}`);
      for (const listener of this.rollbackListeners) listener();
      throw e;
    }
  }

  /** Called after any rolled-back transaction, so in-memory copies of rows it may have written can be dropped. */
  onRollback(listener: () => void): void {
    this.rollbackListeners.add(listener);
  }

  get version(): number {
    const row = this.raw.prepare("PRAGMA user_version").get() as { user_version: number };
    return row.user_version;
  }

  /**
   * Each migration runs in its own transaction with foreign keys off, the
   * documented way to rebuild a table in SQLite; the check afterwards catches
   * anything a rebuild left dangling before constraints come back on.
   */
  private migrate(): void {
    const applied = this.version;
    if (applied >= migrations.length) return;
    this.raw.exec("PRAGMA foreign_keys = OFF");
    try {
      for (let i = applied; i < migrations.length; i += 1) {
        const migration = migrations[i];
        if (!migration) continue;
        this.raw.exec("BEGIN");
        try {
          if (typeof migration === "string") this.raw.exec(migration);
          else migration(this.raw);
          const broken = this.raw.prepare("PRAGMA foreign_key_check").all();
          if (broken.length > 0) throw new Error(`migration ${i + 1} left ${broken.length} dangling foreign key row(s)`);
          this.raw.exec(`PRAGMA user_version = ${i + 1}`);
          this.raw.exec("COMMIT");
        } catch (e) {
          this.raw.exec("ROLLBACK");
          throw e;
        }
      }
    } finally {
      this.raw.exec("PRAGMA foreign_keys = ON");
    }
  }

  close(): void {
    this.statements.clear();
    this.rollbackListeners.clear();
    this.raw.close();
  }
}
