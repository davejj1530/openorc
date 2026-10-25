import { Db } from "@openorc/db";
import { ReviewService } from "../services/review.js";
import { threadAndProject } from "./context.js";
import type { Handlers } from "./types.js";
type Dependencies = {
  review: Pick<ReviewService, "threadDiff" | "threadChanges" | "threadFileDiff" | "commitThread" | "pushThread" | "createThreadPr" | "threadPrTemplate" | "threadLog" | "threadPushState">;
  db: Db;
  invalidate: (keys: string[]) => void;
};

export function createReviewThreadHandlers({
  review,
  db,
  invalidate,
}: Dependencies): Pick<
  Handlers,
  | "review.threadDiff"
  | "review.threadChanges"
  | "review.threadFileDiff"
  | "review.commitThread"
  | "review.pushThread"
  | "review.createThreadPr"
  | "review.threadPrTemplate"
  | "git.threadLog"
  | "git.threadPushState"
> {
  /**
   * A write's own invalidations once it lands. A refused one still says the thread's log and push state changed: its
   * lease is free again, and a phone that lost the write's answer waits for that before it settles what happened.
   */
  async function landed<T>(threadId: string, keys: string[], write: () => Promise<T>): Promise<T> {
    try {
      const result = await write();
      invalidate(keys);
      return result;
    } catch (error) {
      invalidate([`threadlog:${threadId}`]);
      throw error;
    }
  }

  return {
    "review.threadDiff": ({ threadId, comparison }) => {
      const { thread, project } = threadAndProject(db, threadId);
      return review.threadDiff(thread, project, comparison);
    },
    "review.threadChanges": ({ threadId, comparison }) => {
      const { thread, project } = threadAndProject(db, threadId);
      return review.threadChanges(thread, project, comparison);
    },
    "review.threadFileDiff": ({ threadId, comparison, path }) => {
      const { thread, project } = threadAndProject(db, threadId);
      return review.threadFileDiff(thread, project, path, comparison);
    },
    "review.commitThread": ({ threadId, message }) => {
      const { thread, project } = threadAndProject(db, threadId);
      const keys = ["workspace-diff", `threaddiff:${threadId}`, `threadlog:${threadId}`, `thread:${threadId}`, "threads", "orchestration"];
      return landed(threadId, keys, () => review.commitThread(thread, project, message));
    },
    "review.pushThread": ({ threadId }) => {
      const { thread, project } = threadAndProject(db, threadId);
      return landed(threadId, [`thread:${threadId}`, "threads", "orchestration"], () => review.pushThread(thread, project));
    },
    "review.createThreadPr": ({ threadId, title, body, base }) => {
      const { thread, project } = threadAndProject(db, threadId);
      return landed(threadId, ["threads", `thread:${threadId}`], () => review.createThreadPr(thread, project, title, body, base));
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
