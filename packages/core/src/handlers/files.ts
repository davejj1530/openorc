import { listSkills } from "@openorc/agents";
import { audit, Db } from "@openorc/db";
import type { FileScope } from "@openorc/protocol";
import { conversationFolder } from "../services/conversation-folder.js";
import { FileService } from "../services/files.js";
import { listDirectory } from "../services/file-directory.js";
import type { Handlers } from "./types.js";
type Dependencies = {
  db: Db;
  claudeEnvironment?: (id?: string) => NodeJS.ProcessEnv;
  files: Pick<FileService, "search" | "read" | "write" | "find" | "format">;
};

/** One conversation, or one new conversation's folder, whose finds supersede each other. */
const conversationKey = (scope: FileScope) => (scope.kind === "project" ? `project:${scope.id}:${scope.workingDirectory ?? ""}` : `${scope.kind}:${scope.id}`);

export function createFilesHandlers({
  db,
  files,
  claudeEnvironment,
}: Dependencies): Pick<Handlers, "skills.list" | "files.list" | "files.search" | "files.read" | "files.write" | "files.find" | "files.format"> {
  return {
    "skills.list": async ({ projectId, workingDirectory, agent, claudeAccountId }) =>
      listSkills({
        projectRoot: (await conversationFolder(db, { kind: "project", id: projectId, workingDirectory })).root,
        agent,
        ...(agent === "claude" && claudeEnvironment ? { env: claudeEnvironment(claudeAccountId) } : {}),
      }),
    "files.list": async ({ scope, path }) => listDirectory((await conversationFolder(db, scope)).root, path),
    "files.search": async ({ scope, query, limit }) => files.search(await conversationFolder(db, scope), query, limit),
    "files.read": async ({ scope, path }) => files.read(await conversationFolder(db, scope), path),
    "files.write": async ({ scope, path, text, expected }) => {
      const result = await files.write(await conversationFolder(db, scope), { path, text, expected, format: true });
      if (result.kind === "saved") audit.record(db, { actor: "user", action: "files.write", resourceType: scope.kind, resourceId: scope.id, metadata: { path } });
      return result;
    },
    "files.find": ({ scope, query }) => files.find(conversationKey(scope), conversationFolder(db, scope), query),
    "files.format": async ({ scope, path, text }) => files.format(await conversationFolder(db, scope), path, text),
  };
}
