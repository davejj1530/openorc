import { teamTasks, type Db } from "@openorc/db";
import type { TeamTaskAdmission } from "@openorc/protocol";
import { randomUUID } from "node:crypto";
import type { ReviewService } from "./review.js";

/** Retries reuse their accepted review selection; only a new selection creates a batch. */
export function admissionReviewBatch({
  db,
  previous,
  selection,
  instanceId,
  taskId,
}: {
  db: Db;
  previous: TeamTaskAdmission | null;
  selection: ReturnType<ReviewService["composeSelectedComments"]> | null;
  instanceId: string;
  taskId: string;
}) {
  if (previous?.reviewBatchId) return teamTasks.batch(db, previous.reviewBatchId);
  if (!selection) return null;
  return teamTasks.createBatch(db, { id: randomUUID(), instanceId, taskId, ...selection, createdAt: Date.now() });
}
