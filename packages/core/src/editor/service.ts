import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { editorLanguage, editorText, type EditorRequest, type EditorResult } from "@openorc/protocol";
import type { ConversationFolder } from "../services/conversation-folder.js";
import type { IntelligenceEngine } from "./worker-intelligence.js";

function inside(root: string, target: string): boolean {
  // Paths here have already passed FolderPath; realpath also catches symlinks escaping a worktree.
  const local = relative(root, target);
  return local !== ".." && !local.startsWith(`..${sep}`) && !isAbsolute(local);
}

async function contained(root: string, path: string): Promise<boolean> {
  const file = resolve(root, path);
  const target = await realpath(file).catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return resolve(await realpath(dirname(file)), basename(file));
  });
  return inside(root, target);
}

/** The RPC boundary: resolve the conversation's worktree, validate every buffer, and keep navigation/fixes inside it. */
export class EditorService {
  constructor(private readonly engine: IntelligenceEngine | null) {}

  async query(folder: Pick<ConversationFolder, "root" | "readOnly">, input: EditorRequest): Promise<EditorResult> {
    if (!this.engine) return { kind: "unavailable", reason: "Code intelligence is unavailable in this host." };
    if (!editorLanguage(input.path)) return { kind: "unavailable", reason: "Code intelligence supports TypeScript and JavaScript files." };
    if (folder.readOnly && input.query.kind === "fixes") return { kind: "fixes", fixes: [] };
    for (const document of input.documents) {
      if (!(await contained(folder.root, document.path))) throw new Error("An editor buffer is outside the conversation's workspace.");
      if (Buffer.byteLength(document.text, "utf8") > 2 * 1024 * 1024) throw new Error("This editor buffer is too large to analyze (2 MB maximum).");
    }
    const documents = input.documents.map((document) => ({ ...document, text: editorText(document.text) }));
    const result = await this.engine.query({ ...input, root: folder.root, documents });
    if (result.kind === "definition" || result.kind === "references") {
      const allowed = await Promise.all(result.locations.map((target) => contained(folder.root, target.path).catch(() => false)));
      return { ...result, locations: result.locations.filter((_, index) => allowed[index]) };
    }
    if (result.kind === "fixes") {
      const allowed = await Promise.all(result.fixes.map(async (fix) => (await Promise.all(fix.changes.map((change) => contained(folder.root, change.path).catch(() => false)))).every(Boolean)));
      return { ...result, fixes: result.fixes.filter((_, index) => allowed[index]) };
    }
    return result;
  }

  async close(): Promise<void> {
    await this.engine?.close();
  }
}
