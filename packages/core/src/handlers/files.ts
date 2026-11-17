import { audit, Db } from "@openorc/db";
import type { FileScope } from "@openorc/protocol";
import type { ConversationFolder } from "../services/conversation-folder.js";
import { FileService } from "../services/files.js";
import { listDirectory } from "../services/file-directory.js";
import type { Handlers } from "./types.js";
type Dependencies = {
  db: Db;
  files: Pick<FileService, "search" | "read" | "write" | "find" | "format" | "intelligence">;
  /** Where a scope's files are: its conversation's folder, or a cloud thread's reading copy. */
  folder: (scope: FileScope) => Promise<ConversationFolder>;
};

/** One conversation, or one new conversation's folder, whose finds supersede each other. */
const conversationKey = (scope: FileScope) => (scope.kind === "project" ? `project:${scope.id}:${scope.workingDirectory ?? ""}` : `${scope.kind}:${scope.id}`);

export function createFilesHandlers({
  db,
  files,
  folder: folderOf,
}: Dependencies): Pick<Handlers, "files.list" | "files.search" | "files.read" | "files.write" | "files.find" | "files.format" | "editor.query"> {
  return {
    "editor.query": async ({ scope, expectedRoot, ...input }) => {
      const folder = await folderOf(scope);
      if (folder.root !== expectedRoot) return { kind: "unavailable", reason: "This conversation changed workspace. Reopen the file to analyze its new workspace." };
      return files.intelligence.query(folder, input);
    },
    "files.list": async ({ scope, path }) => listDirectory((await folderOf(scope)).root, path),
    "files.search": async ({ scope, query, limit }) => files.search(await folderOf(scope), query, limit),
    "files.read": async ({ scope, path }) => files.read(await folderOf(scope), path, { outside: true }),
    "files.write": async ({ scope, path, text, expected }) => {
      const result = await files.write(await folderOf(scope), { path, text, expected, format: true });
      if (result.kind === "saved") audit.record(db, { actor: "user", action: "files.write", resourceType: scope.kind, resourceId: scope.id, metadata: { path } });
      return result;
    },
    "files.find": ({ scope, query }) => files.find(conversationKey(scope), folderOf(scope), query),
    "files.format": async ({ scope, path, text }) => files.format(await folderOf(scope), path, text),
  };
}
