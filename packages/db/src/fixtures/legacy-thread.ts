import { randomUUID } from "node:crypto";
import type { Thread } from "@openorc/protocol";
import type { Db } from "../database.js";
import { threads } from "../repos.js";

type LegacyThread = Pick<Thread, "projectId" | "title" | "agent" | "model" | "mode" | "permissionMode"> & Partial<Pick<Thread, "id" | "effort" | "fastMode" | "workspaceMode">>;

/** Frozen pre-account writer, so historical migration fixtures do not require future columns. */
export function insertLegacyThread(db: Db, thread: LegacyThread): Thread {
  const id = thread.id ?? randomUUID();
  const at = Date.now();
  db.stmt(
    "INSERT INTO threads (id,project_id,title,agent,model,effort,fast_mode,mode,permission_mode,workspace_mode,seen_at,created_at,updated_at,last_activity_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(
    id,
    thread.projectId,
    thread.title,
    thread.agent,
    thread.model,
    thread.effort ?? null,
    Number(thread.fastMode ?? false),
    thread.mode,
    thread.permissionMode,
    thread.workspaceMode ?? "current",
    at,
    at,
    at,
    at,
  );
  return threads.get(db, id)!;
}
