import { join } from "node:path";
import { tasks, threads, type Db } from "@openorc/db";
import { defaultHarnessId, type FileScope, type HarnessId } from "@openorc/protocol";
import { conversationFolder } from "../services/conversation-folder.js";
import { CodeExplanationService, type ExplainConversation } from "../services/code-explanations.js";
import type { FileService } from "../services/files.js";
import type { AppSettingsService } from "../services/settings.js";
import type { TextGenerationService } from "../services/text-generation.js";
import type { Handlers } from "./types.js";

interface Dependencies {
  db: Db;
  files: Pick<FileService, "find">;
  textGeneration: Pick<TextGenerationService, "complete">;
  /** Explanations are kept under it, in `code-explanations`. */
  dataDir: string;
  /** Its default harness explains a project's files before any conversation exists. */
  settings: Pick<AppSettingsService, "get">;
}

/** A thread's or a task's conversation explains with its own agent and Claude account, as it names itself. */
function conversationAgent(db: Db, scope: FileScope, defaultAgent: () => HarnessId): Omit<ExplainConversation, "find"> {
  const task = scope.kind === "task" ? tasks.get(db, scope.id) : null;
  const threadId = scope.kind === "thread" ? scope.id : task?.executionThreadId;
  const thread = threadId ? threads.get(db, threadId) : null;
  if (!thread) return { agent: defaultAgent() };
  return { agent: thread.agent, ...(thread.claudeAccountId ? { claudeAccountId: thread.claudeAccountId } : {}) };
}

let lookups = 0;
const conversationKey = (scope: FileScope) => (scope.kind === "project" ? `project:${scope.id}:${scope.workingDirectory ?? ""}` : `${scope.kind}:${scope.id}`);

export function createCodeExplanationHandlers({ db, files, textGeneration, settings, dataDir }: Dependencies): Pick<Handlers, "code.explain"> {
  const defaultAgent = () => settings.get().defaultHarness ?? defaultHarnessId;
  const explanations = new CodeExplanationService({ dir: join(dataDir, "code-explanations"), complete: (request) => textGeneration.complete(request) });
  return {
    "code.explain": ({ scope, path, text, view, refresh }) =>
      explanations.explain(
        { path, text, view, ...(refresh ? { refresh } : {}) },
        {
          ...conversationAgent(db, scope, defaultAgent),
          // A find key of its own, so a lookup of callers never stops the user's find or another explanation's lookup.
          find: (query) => files.find(`explain:${conversationKey(scope)}:${++lookups}`, conversationFolder(db, scope), query),
        },
      ),
  };
}
