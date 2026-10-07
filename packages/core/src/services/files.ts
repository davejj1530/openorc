import { glob, open, realpath, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { git } from "@openorc/git";
import { FolderPath, inGitFolder, type FileExpectation, type FileRead, type FileWriteResult, type FindQuery, type FindResult, type FormatResult } from "@openorc/protocol";
import type { ConversationFolder } from "./conversation-folder.js";
import { findInFolder } from "./file-find.js";
import type { FileFormatter } from "./file-format.js";
import { MAX_FILE_BYTES, versionOf, writeVersioned, type WriteOutcome } from "./file-write.js";
import { projectGit } from "./project-git.js";
import type { WorkspaceWriters } from "./workspace-writers.js";

/** Folders a .gitignore usually hides; a folder without git has none, so they are skipped by name. */
const UNLISTED = new Set(["node_modules", "bower_components", "vendor", "dist", "build", "out", "target", "coverage", "__pycache__", "venv"]);
/** A folder without git can be as large as a home directory; @ mentions only need a useful start. */
const MAX_FOLDER_FILES = 20_000;
/** How long a save waits for a commit, restore or move to finish before it reports the folder busy. */
const SAVE_WAIT_MS = 5_000;
/** A turn start reads the journal back only as far as the thread's last checkpoint, so each folder keeps a bounded tail. */
const JOURNAL_LIMIT = 500;

/** A folder's files without git: hidden entries and the folders above are skipped, as a .gitignore would. */
async function folderFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  for await (const entry of glob("**", { cwd: root, withFileTypes: true, exclude: (dirent) => dirent.name.startsWith(".") || UNLISTED.has(dirent.name) })) {
    if (entry.isFile()) files.push(relative(root, join(entry.parentPath, entry.name)));
    if (files.length >= MAX_FOLDER_FILES) break;
  }
  return files;
}

interface Listing {
  at: number;
  files: string[];
}

interface Save {
  path: FolderPath;
  at: number;
}

interface FileServiceDependencies {
  writers: Pick<WorkspaceWriters, "withLease">;
  /** Refresh keys for every window: `workspace-diff` after a save, `files` after a create. */
  invalidate: (keys: string[]) => void;
  formatter: Pick<FileFormatter, "format">;
}

/** Ranks a path for a query: a basename that starts with it beats one that contains it beats a directory match. */
export function rankPath(file: string, query: string): number {
  const q = query.toLowerCase();
  const lower = file.toLowerCase();
  const base = lower.slice(lower.lastIndexOf("/") + 1);
  if (base === q) return 0;
  if (base.startsWith(q)) return 1;
  if (base.includes(q)) return 2;
  if (lower.includes(q)) return 3;
  // Every character in order, the way editors' quick-open matches.
  let i = 0;
  for (const c of lower) if (c === q[i]) i += 1;
  return i === q.length ? 4 : -1;
}

function missing(error: NodeJS.ErrnoException): null {
  if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
  throw error;
}

function folderPath(root: string, absolute: string): FolderPath {
  const local = relative(root, absolute);
  if (!local) throw new Error("This path is a folder, not a file.");
  if (local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local)) throw new Error("This file is outside the conversation's workspace.");
  return FolderPath.parse(local.split(sep).join("/"));
}

/** Reads one byte past the limit, so a file another process grew after the size check is still caught. */
async function boundedBytes(file: FileHandle): Promise<Buffer | null> {
  const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
  let length = 0;
  while (length < buffer.length) {
    const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
    if (!bytesRead) break;
    length += bytesRead;
  }
  return length > MAX_FILE_BYTES ? null : buffer.subarray(0, length);
}

/** TextDecoder drops a leading byte order mark, which Buffer.toString would keep. */
function utf8(bytes: Buffer): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** A conversation's files as the editor sees them: listed for @ mentions, read with a version, and saved only while still as read. */
export class FileService {
  /** File lists by folder root, kept for half a minute, so two conversations in one folder share one listing. */
  private readonly listings = new Map<string, Listing>();
  /** What the editor saved per folder root, newest last. A turn start reads it to credit changes between turns to the user. */
  private readonly journal = new Map<string, Save[]>();
  /** Real paths of files created here. The bundled formatter may format only these on save. Lost on restart. */
  private readonly created = new Set<string>();
  /** The running find per conversation. A newer one aborts it, which stops its git process. */
  private readonly finds = new Map<string, AbortController>();

  constructor(private readonly deps: FileServiceDependencies) {}

  async read(folder: Pick<ConversationFolder, "root" | "readOnly">, path: string): Promise<FileRead> {
    if (path.includes("\0")) throw new Error("Invalid file path.");
    const requested = resolve(folder.root, path);
    const target = await realpath(requested).catch(missing);
    const local = folderPath(folder.root, target ?? requested);
    if (!target) return { kind: "missing", root: folder.root, path: local };
    const unreadable = (reason: string): FileRead => ({ kind: "unreadable", root: folder.root, path: local, reason });
    const file = await open(target, "r");
    try {
      const stat = await file.stat();
      if (!stat.isFile()) return unreadable("This path is a folder, not a file.");
      const bytes = stat.size > MAX_FILE_BYTES ? null : await boundedBytes(file);
      if (!bytes) return unreadable("This file is too large to open (2 MB maximum).");
      if (bytes.includes(0)) return unreadable("This is a binary file and cannot be shown as code.");
      const text = utf8(bytes);
      if (text === null) return unreadable("This file is not UTF-8 text and cannot be shown.");
      return {
        kind: "file",
        root: folder.root,
        path: local,
        absolutePath: target,
        version: versionOf(bytes),
        text,
        readOnly: folder.readOnly ?? (inGitFolder(local) ? "Git's own files are read-only here." : null),
      };
    } finally {
      await file.close();
    }
  }

  /**
   * Saves editor text when the file is still as `expected`. Refuses read-only folders and Git's own files. With `format`,
   * the project's formatter formats the text first, outside any lease, or the bundled one does for a file created here;
   * a formatter that fails leaves the text as typed and says why. Then writes under a short shared lease that coexists
   * with agents and waits out a commit, restore or move. A `conflict` carries the file as it is now. A save pushes
   * `workspace-diff`; a create also pushes `files`, so quick open sees the file.
   */
  async write(folder: Pick<ConversationFolder, "root" | "readOnly" | "kind">, input: { path: FolderPath; text: string; expected: FileExpectation; format: boolean }): Promise<FileWriteResult> {
    if (folder.readOnly) throw new Error(folder.readOnly);
    if (inGitFolder(input.path)) throw new Error("Git's own files are read-only here.");
    const absolutePath = join(folder.root, input.path);
    const formatted = input.format ? await this.deps.formatter.format(folder, input.path, input.text, this.createdHere(absolutePath)) : null;
    const text = formatted?.kind === "formatted" ? formatted.text : input.text;
    const outcome = await this.save(folder.root, input.path, text, input.expected);
    if (outcome.kind === "conflict") return { kind: "conflict", current: await this.read(folder, input.path) };
    if (input.expected.kind === "absent") {
      this.created.add(absolutePath);
      this.listings.delete(folder.root);
    }
    this.deps.invalidate(input.expected.kind === "absent" ? ["workspace-diff", "files"] : ["workspace-diff"]);
    const formatError = formatted?.kind === "failed" ? formatted.message : null;
    return { kind: "saved", root: folder.root, path: input.path, absolutePath, version: outcome.version, text: text === input.text ? null : text, formatError };
  }

  /** Shift+Option+F: the text as the file's formatter writes it, the bundled one standing in for any file. Saves nothing. */
  format(folder: Pick<ConversationFolder, "root" | "kind">, path: FolderPath, text: string): Promise<FormatResult> {
    return this.deps.formatter.format(folder, path, text, true);
  }

  /** The atomic, version-checked write every surface that edits files shares. A write that lands is journaled under `root`. */
  async save(root: string, path: FolderPath, text: string, expected: FileExpectation): Promise<WriteOutcome> {
    const outcome = await this.deps.writers.withLease(join(root, path), `saving ${path}`, (lease) => writeVersioned(lease, root, path, text, expected), undefined, {
      shared: true,
      waitForExclusive: () => {},
      maxWaitMs: SAVE_WAIT_MS,
    });
    if (outcome.kind === "written") {
      const saves = this.journal.get(root) ?? [];
      saves.push({ path, at: Date.now() });
      this.journal.set(root, saves.slice(-JOURNAL_LIMIT));
    }
    return outcome;
  }

  /** Paths saved under `root` at or after `since`, each once. */
  savedSince(root: string, since: number): FolderPath[] {
    return [...new Set((this.journal.get(root) ?? []).filter((save) => save.at >= since).map((save) => save.path))];
  }

  /** Whether the file at this real path was created in OpenOrc's editor. */
  createdHere(absolutePath: string): boolean {
    return this.created.has(absolutePath);
  }

  async search(folder: Pick<ConversationFolder, "root" | "project">, query: string, limit = 20): Promise<string[]> {
    const files = await this.list(folder);
    const q = query.trim();
    if (!q) return files.slice(0, limit);
    return files
      .map((f) => ({ f, rank: rankPath(f, q) }))
      .filter((x) => x.rank >= 0)
      .sort((a, b) => a.rank - b.rank || a.f.length - b.f.length)
      .slice(0, limit)
      .map((x) => x.f);
  }

  /**
   * Find in files for one conversation. RPC has no cancellation, so a newer find for the same conversation stops this
   * one, which answers `superseded`. It takes its place before the folder resolves, so finds supersede in arrival order.
   */
  async find(conversation: string, folder: Promise<Pick<ConversationFolder, "root" | "project">>, query: FindQuery): Promise<FindResult> {
    this.finds.get(conversation)?.abort();
    const newer = new AbortController();
    this.finds.set(conversation, newer);
    try {
      const { root, project } = await folder;
      const git = (await projectGit({ id: project.id, rootPath: root })) !== "none";
      const result = await findInFolder({ root, git, files: () => this.list({ root, project }) }, query, newer.signal);
      return newer.signal.aborted ? { kind: "superseded" } : result;
    } finally {
      if (this.finds.get(conversation) === newer) this.finds.delete(conversation);
    }
  }

  private async list({ root, project }: Pick<ConversationFolder, "root" | "project">): Promise<string[]> {
    const hit = this.listings.get(root);
    if (hit && Date.now() - hit.at < 30_000) return hit.files;
    const files =
      (await projectGit({ id: project.id, rootPath: root })) === "none"
        ? await folderFiles(root)
        : (await git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { maxBuffer: 256 * 1024 * 1024 })).stdout.split("\0").filter(Boolean);
    this.listings.set(root, { at: Date.now(), files });
    return files;
  }
}
