import { threads, type Db } from "@openorc/db";
import type { BrainMirrors } from "../services/brain-mirrors.js";
import { snapshotFolder } from "../services/brain-mirrors.js";
import type { CloudWorkspaceService } from "../services/cloud-workspaces.js";
import { executionProject } from "../services/workspace-home.js";
import type { Handlers } from "./types.js";

type Method = "threads.snapshot" | "cloud.openOnMac" | "cloud.closeOnMac";

/** A cloud thread's code for its Mac's copy (on the brain), and that copy opened or closed (on the Mac). */
export function createBrainThreadHandlers({ db, cloud, mirrors }: { db: Db; cloud: Pick<CloudWorkspaceService, "sync">; mirrors: () => BrainMirrors | null }): Pick<Handlers, Method> {
  const copies = () => {
    const found = mirrors();
    if (!found) throw new Error("Only a Mac with a cloud brain opens its conversations.");
    return found;
  };
  return {
    "threads.snapshot": async ({ threadId, known }) => {
      const thread = threads.get(db, threadId);
      if (!thread?.worktreePath) throw new Error("That conversation has no code here.");
      // The sandbox's last changes first, so the copy shows what the agent did.
      await cloud.sync(thread).catch(() => false);
      return snapshotFolder(executionProject(db, thread).rootPath, thread.worktreePath, threadId, known);
    },
    "cloud.openOnMac": async ({ threadId }) => {
      await copies().open(threadId);
      return null;
    },
    "cloud.closeOnMac": async ({ threadId }) => {
      await copies().close(threadId);
      return null;
    },
  };
}
