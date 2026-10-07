import { instructionFiles } from "@openorc/agents";
import { audit, Db } from "@openorc/db";
import { executionFolder } from "../services/conversation-folder.js";
import type { FileService } from "../services/files.js";
import { readInstructionFiles, saveInstructionFile } from "../services/instruction-files.js";
import { threadAndProject } from "./context.js";
import type { Handlers } from "./types.js";
type Dependencies = {
  db: Db;
  files: Pick<FileService, "save">;
  claudeEnvironment?: (id?: string) => NodeJS.ProcessEnv;
};

export function createInstructionsHandlers({ db, files, claudeEnvironment }: Dependencies): Pick<Handlers, "instructions.list" | "instructions.save"> {
  /** The files the thread's current agent reads, in the folder it works in. */
  const locations = (threadId: string) => {
    const { thread, project } = threadAndProject(db, threadId);
    return instructionFiles({
      agent: thread.agent,
      folder: executionFolder({ thread, task: null }, project),
      ...(thread.agent === "claude" && claudeEnvironment ? { env: claudeEnvironment(thread.claudeAccountId ?? "claude-cli") } : {}),
    });
  };
  return {
    "instructions.list": ({ threadId }) => readInstructionFiles(locations(threadId)),
    "instructions.save": async ({ threadId, path, content, version }) => {
      // Only a file the agent reads is written, never a path the caller chose.
      const location = locations(threadId).find((candidate) => candidate.path === path);
      if (!location) throw new Error("This file is not one of the conversation's instruction files.");
      const saved = await saveInstructionFile(files, location, content, version);
      audit.record(db, { actor: "user", action: "instructions.save", resourceType: "thread", resourceId: threadId, metadata: { path } });
      return saved;
    },
  };
}
