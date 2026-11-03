import { audit, type Db } from "@openorc/db";
import type { PermissionPreset, RunMode, Thread } from "@openorc/protocol";
import type { RunService } from "./runs.js";

/** A permission or mode the user asked a conversation for reaches its processes, recorded with what took effect. */
export function applyRequestedPolicy(db: Db, runs: Pick<RunService, "applyThreadPermissions">, thread: Thread, previous: { permission: PermissionPreset | null; mode: RunMode | null }): void {
  const policy = runs.applyThreadPermissions(thread);
  const record = { actor: "user", resourceType: "thread", resourceId: thread.id } as const;
  if (previous.permission !== null && previous.permission !== thread.permissionMode)
    audit.record(db, {
      ...record,
      action: "thread.permissions_requested",
      metadata: { previous: previous.permission, requested: policy.requested, effective: policy.effective, pendingRestart: policy.pendingRestart, runs: policy.runs },
    });
  if (previous.mode === null || previous.mode === thread.mode) return;
  audit.record(db, { ...record, action: "thread.mode_requested", metadata: { previous: previous.mode, requested: thread.mode, effective: policy.mode?.effective, pending: policy.mode?.pending } });
}
