import { Db } from "@openorc/db";
import { ReviewService } from "../services/review.js";
import { threadAndProject } from "./context.js";
import type { Handlers } from "./types.js";
type Dependencies = {
  review: Pick<ReviewService, "threadDiff" | "commitThread" | "pushThread" | "createThreadPr" | "threadPrTemplate" | "threadLog" | "threadPushState">;
  db: Db;
  invalidate: (keys: string[]) => void;
};

export function createReviewThreadHandlers({
  review,
  db,
  invalidate,
}: Dependencies): Pick<Handlers, "review.threadDiff" | "review.commitThread" | "review.pushThread" | "review.createThreadPr" | "review.threadPrTemplate" | "git.threadLog" | "git.threadPushState"> {
  return {
    "review.threadDiff": ({ threadId, comparison }) => {
      const { thread, project } = threadAndProject(db, threadId);
      return review.threadDiff(thread, project, comparison);
    },
    "review.commitThread": async ({ threadId, message }) => {
      const { thread, project } = threadAndProject(db, threadId);
      const r = await review.commitThread(thread, project, message);
      invalidate(["workspace-diff", `threaddiff:${threadId}`, `threadlog:${threadId}`, `thread:${threadId}`, "threads", "orchestration"]);
      return r;
    },
    "review.pushThread": async ({ threadId }) => {
      const { thread, project } = threadAndProject(db, threadId);
      const result = await review.pushThread(thread, project);
      invalidate([`thread:${threadId}`, "threads", "orchestration"]);
      return result;
    },
    "review.createThreadPr": async ({ threadId, title, body }) => {
      const { thread, project } = threadAndProject(db, threadId);
      const r = await review.createThreadPr(thread, project, title, body);
      invalidate(["threads", `thread:${threadId}`]);
      return r;
    },
    "review.threadPrTemplate": ({ threadId }) => {
      const { thread, project } = threadAndProject(db, threadId);
      return review.threadPrTemplate(thread, project);
    },
    "git.threadLog": ({ threadId, limit }) => {
      const { thread, project } = threadAndProject(db, threadId);
      return review.threadLog(thread, project, limit);
    },
    "git.threadPushState": ({ threadId }) => {
      const { thread, project } = threadAndProject(db, threadId);
      return review.threadPushState(thread, project);
    },
  };
}
