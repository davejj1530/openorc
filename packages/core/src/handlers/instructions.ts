import { instructionFiles } from "@openorc/agents";
import { audit, Db } from "@openorc/db";
import { readInstructionFiles, saveInstructionFile } from "../services/instruction-files.js";
import { threadAndProject } from "./context.js";
import type { Handlers } from "./types.js";
type Dependencies = {
  db: Db;
};

export function createInstructionsHandlers({ db }: Dependencies): Pick<Handlers, "instructions.list" | "instructions.save"> {
  /** The files the thread's current agent reads, in the folder it works in. */
  const locations = (threadId: string) => {
    const { thread, project } = threadAndProject(db, threadId);
    return instructionFiles({ agent: thread.agent, folder: thread.worktreePath ?? project.rootPath });
  };
  return {
    "instructions.list": ({ threadId }) => readInstructionFiles(locations(threadId)),
    "instructions.save": async ({ threadId, path, content, version }) => {
      // Only a file the agent reads is written, never a path the caller chose.
      const location = locations(threadId).find((candidate) => candidate.path === path);
      if (!location) throw new Error("This file is not one of the conversation's instruction files.");
      const saved = await saveInstructionFile(location, content, version);
      audit.record(db, { actor: "user", action: "instructions.save", resourceType: "thread", resourceId: threadId, metadata: { path } });
      return saved;
    },
  };
}
