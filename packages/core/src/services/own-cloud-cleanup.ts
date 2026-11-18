import { rm } from "node:fs/promises";
import path from "node:path";
import { settings, type Db } from "@openorc/db";
import type { Logger } from "../transport.js";
import { closeMirror, openMirrors } from "./brain-mirrors.js";

/** Set once the cleanup ran, so it never runs again: what this profile holds after it is not the own cloud's. */
const DONE = "own-cloud.removed";

/** The protected stores the own cloud kept: its connections, each agent's sign-in there, project environments, the brain's key. */
const FILES = ["cloud-credentials.enc", "claude-cloud-tokens.enc", "codex-cloud-login.enc", "opencode-cloud-keys.enc", "cloud-env.enc", "cloud-brain.enc", "cloud-brain-move.enc"];

/** Sandboxes simulated on this Mac, session copies a move replaced, and read-only copies of a brain's threads. */
const FOLDERS = ["cloud-sandboxes", "kept-sessions", "mirrors"];

/**
 * Every settings row the own cloud wrote, but one: the brains this Mac removed, which a phone that paired one still
 * asks for, to forget it.
 */
const SETTINGS = "(key LIKE 'cloud.%' OR key LIKE 'brain.%' OR key = 'mac.backlog') AND key != 'brain.removed'";

/**
 * Once, at start: takes what the person's own cloud left in a profile out of it. The app no longer runs threads on a
 * person's own cloud machine, so nothing else could. A thread that ran in a sandbox becomes a plain worktree
 * thread: its worktree here holds its code as of the last sync, and what the sandbox had after that is not brought
 * back. A thread a move had frozen is released. The connections, tokens and kept lists are deleted. Threads still on a
 * cloud brain are out of reach: nothing here can fetch them.
 */
export async function removeOwnCloud(db: Db, dataDir: string, log: Pick<Logger, "info" | "warn">): Promise<void> {
  if (settings.get(db, DONE)) return;
  for (const threadId of openMirrors(db)) {
    await closeMirror(db, threadId, log).catch((error: unknown) => log.warn(`thread ${threadId}'s copy on this Mac was not removed: ${error instanceof Error ? error.message : String(error)}`));
  }
  const sandboxed = db.transaction(() => {
    const { changes } = db.stmt("DELETE FROM cloud_workspaces").run();
    db.stmt("DELETE FROM thread_relocations").run();
    db.stmt("DELETE FROM memory_tombstones").run();
    db.stmt(`DELETE FROM settings WHERE ${SETTINGS}`).run();
    return Number(changes);
  });
  if (sandboxed > 0) {
    const threads = sandboxed === 1 ? "1 thread that ran in your own cloud now works" : `${sandboxed} threads that ran in your own cloud now work`;
    log.info(`${threads} in a worktree on this Mac, with the code as of the last sync. What a sandbox changed after that did not come along.`);
  }
  await Promise.all([...FILES.map((file) => rm(path.join(dataDir, file), { force: true })), ...FOLDERS.map((folder) => rm(path.join(dataDir, folder), { recursive: true, force: true }))]);
  settings.set(db, DONE, new Date().toISOString());
}
