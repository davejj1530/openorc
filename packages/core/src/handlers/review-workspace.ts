import { Db, projects } from "@openorc/db";
import { ReviewService } from "../services/review.js";
import { TaskCheckoutService } from "../services/task-checkout.js";
import { reviewWorkspace, taskAndProject } from "./context.js";
import type { Handlers } from "./types.js";
type Dependencies = {
  review: Pick<ReviewService, "diff" | "projectDiff" | "commitProject" | "snapshots" | "markReviewed" | "commit" | "exportPatch" | "push" | "createPr" | "log">;
  db: Db;
  taskCheckout: Pick<TaskCheckoutService, "state">;
  invalidate: (keys: string[]) => void;
};

export function createReviewWorkspaceHandlers({
  review,
  db,
  taskCheckout,
  invalidate,
}: Dependencies): Pick<
  Handlers,
  | "review.diff"
  | "review.projectDiff"
  | "review.commitProject"
  | "review.snapshots"
  | "review.markReviewed"
  | "review.commit"
  | "review.checkoutState"
  | "review.exportPatch"
  | "review.push"
  | "review.createPr"
  | "git.log"
> {
  return {
    "review.diff": async ({ taskId, sinceReviewed }) => {
      const { task, project } = await reviewWorkspace(db, taskId);
      return review.diff(task, project, { sinceReviewed: sinceReviewed ?? false });
    },
    "review.projectDiff": ({ projectId }) => {
      const project = projects.get(db, projectId);
      if (!project) throw new Error(`project ${projectId} not found`);
      return review.projectDiff(project);
    },
    "review.commitProject": async ({ projectId, message }) => {
      const project = projects.get(db, projectId);
      if (!project) throw new Error(`project ${projectId} not found`);
      const r = await review.commitProject(project, message);
      invalidate(["workspace-diff", `projectdiff:${projectId}`, "threads"]);
      return r;
    },
    "review.snapshots": ({ taskId }) => review.snapshots(taskId),
    "review.markReviewed": ({ taskId }) => {
      const { task } = taskAndProject(db, taskId);
      const t = review.markReviewed(task);
      invalidate([`task:${taskId}`, `diff:${taskId}`]);
      return t;
    },
    "review.commit": async ({ taskId, message }) => {
      const { task, project } = taskAndProject(db, taskId);
      const r = await review.commit(task, project, message);
      invalidate(["workspace-diff", `diff:${taskId}`, `log:${taskId}`]);
      return r;
    },
    "review.checkoutState": ({ taskId }) => taskCheckout.state(taskId),
    "review.exportPatch": async ({ taskId }) => {
      const { task, project } = taskAndProject(db, taskId);
      return review.exportPatch(task, project);
    },
    "review.push": ({ taskId }) => {
      const { task, project } = taskAndProject(db, taskId);
      return review.push(task, project);
    },
    "review.createPr": ({ taskId, title, body }) => {
      const { task, project } = taskAndProject(db, taskId);
      return review.createPr(task, project, title, body);
    },
    "git.log": async ({ taskId, limit }) => {
      const { task, project } = await reviewWorkspace(db, taskId);
      return review.log(task, project, limit);
    },
  };
}
