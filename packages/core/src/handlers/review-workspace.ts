import { Db, projects } from "@openorc/db";
import { ReviewService } from "../services/review.js";
import { TaskCheckoutService } from "../services/task-checkout.js";
import { reviewWorkspace, taskAndProject } from "./context.js";
import type { Handlers } from "./types.js";
type Dependencies = {
  review: Pick<
    ReviewService,
    "diff" | "projectDiff" | "commitProject" | "projectLog" | "projectPushState" | "pushProject" | "snapshots" | "markReviewed" | "commit" | "exportPatch" | "push" | "createPr" | "log"
  >;
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
  | "git.projectLog"
  | "git.projectPushState"
  | "review.pushProject"
  | "review.snapshots"
  | "review.markReviewed"
  | "review.commit"
  | "review.checkoutState"
  | "review.exportPatch"
  | "review.push"
  | "review.createPr"
  | "git.log"
> {
  const checkout = (projectId: string) => {
    const project = projects.get(db, projectId);
    if (!project) throw new Error(`project ${projectId} not found`);
    return project;
  };
  return {
    "review.diff": async ({ taskId, sinceReviewed }) => {
      const { task, project } = await reviewWorkspace(db, taskId);
      return review.diff(task, project, { sinceReviewed: sinceReviewed ?? false });
    },
    "review.projectDiff": ({ projectId }) => review.projectDiff(checkout(projectId)),
    "review.commitProject": async ({ projectId, message }) => {
      const r = await review.commitProject(checkout(projectId), message);
      invalidate(["workspace-diff", `projectdiff:${projectId}`, "threads"]);
      return r;
    },
    "git.projectLog": ({ projectId, limit }) => review.projectLog(checkout(projectId), limit),
    "git.projectPushState": ({ projectId }) => review.projectPushState(checkout(projectId)),
    "review.pushProject": async ({ projectId }) => {
      const r = await review.pushProject(checkout(projectId));
      invalidate(["workspace-diff", "threads"]);
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
    "review.createPr": ({ taskId, title, body, base }) => {
      const { task, project } = taskAndProject(db, taskId);
      return review.createPr(task, project, title, body, base);
    },
    "git.log": async ({ taskId, limit }) => {
      const { task, project } = await reviewWorkspace(db, taskId);
      return review.log(task, project, limit);
    },
  };
}
