import { open, readdir, realpath, type FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { git } from "@openorc/git";
import {
  fileMedia,
  FolderPath,
  inGitFolder,
  OTHER_MEDIA,
  type FileExpectation,
  type FileMediaEntry,
  type FilePlace,
  type FileRead,
  type FileWriteResult,
  type FindQuery,
  type FindResult,
  type FormatResult,
} from "@openorc/protocol";
import type { ConversationFolder } from "./conversation-folder.js";
import { EditorService } from "../editor/service.js";
import type { IntelligenceEngine } from "../editor/worker-intelligence.js";
import { METADATA } from "./file-directory.js";
import { findInFolder } from "./file-find.js";
import type { FileFormatter } from "./file-format.js";
import { signFileUrl } from "./file-url.js";
import { MAX_FILE_BYTES, versionOf, writeVersioned, type WriteOutcome } from "./file-write.js";
import { projectGit } from "./project-git.js";
import type { WorkspaceWriters } from "./workspace-writers.js";

/** Folders a .gitignore usually hides; a folder without git has none, so they are skipped by name. */
const UNLISTED = new Set(["node_modules", "bower_components", "vendor", "dist", "build", "out", "target", "coverage", "__pycache__", "venv"]);
/** A folder without git can be as large as a home directory; @ mentions only need a useful start. */
const MAX_FOLDER_FILES = 20_000;
/** Git-ignored folders hold caches and data dumps as well as notes; the walk keeps the files nearest the top. */
const MAX_IGNORED_FILES = 200_000;
/** How many folders a walk reads at once. */
const WALK_WIDTH = 16;
/** How long a save waits for a commit, restore or move to finish before it reports the folder busy. */
const SAVE_WAIT_MS = 5_000;
/** A turn start reads the journal back only as far as the thread's last checkpoint, so each folder keeps a bounded tail. */
const JOURNAL_LIMIT = 500;
/** How long a folder's listing is kept. */
const LISTING_MS = 30_000;

/** `.env`, `.env.local` and the like: usually Git-ignored, yet opened all the time. Search ranks them with tracked files; find in files skips them. */
const isEnvFile = (path: string) => /(^|\/)\.env(\.[^/]*)?$/.test(path);

/** Dependencies, build output and metadata: never searched, even where Git ignores them. */
const unlisted = (name: string) => UNLISTED.has(name) || METADATA.has(name);

/** What search offers in a folder: its files, and the ones Git ignores, which rank below them. */
interface Listing {
  files: string[];
  ignored: string[];
}

/** The files under `folders`, nearest first, so the limit cuts the deepest. Links are not followed, and a folder that cannot be read is passed over. */
async function walk(root: string, folders: string[], skipped: (name: string) => boolean, limit: number): Promise<string[]> {
  const files: string[] = [];
  let level = folders;
  while (level.length && files.length < limit) {
    const deeper: string[] = [];
    for (let at = 0; at < level.length && files.length < limit; at += WALK_WIDTH) {
      await Promise.all(
        level.slice(at, at + WALK_WIDTH).map(async (folder) => {
          for (const child of await readdir(join(root, folder), { withFileTypes: true }).catch(() => [])) {
            if (skipped(child.name)) continue;
            const path = folder ? `${folder}/${child.name}` : child.name;
            if (child.isDirectory()) deeper.push(path);
            else if (child.isFile()) files.push(path);
          }
        }),
      );
    }
    level = deeper;
  }
  return files.slice(0, limit);
}

/** A folder's files without git: hidden entries other than env files, and the folders above, are skipped as a .gitignore would. */
async function folderFiles(root: string): Promise<Listing> {
  const skipped = (name: string) => (name.startsWith(".") && !isEnvFile(name)) || UNLISTED.has(name);
  return { files: await walk(root, [""], skipped, MAX_FOLDER_FILES), ignored: [] };
}

/**
 * Tracked and untracked files, and the Git-ignored ones outside dependency and build folders. `--directory` keeps git
 * out of ignored folders: it names each one, and the walk reads those. A folder whose files are each ignored on their
 * own is named along with its files, so only a folder named alone is walked.
 */
async function gitFiles(root: string): Promise<Listing> {
  const [listed, others] = await Promise.all([
    git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { maxBuffer: 256 * 1024 * 1024 }),
    git(root, ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"], { maxBuffer: 256 * 1024 * 1024 }),
  ]);
  const entries = others.stdout.split("\0").filter((entry) => entry && !entry.split("/").some(unlisted));
  const named = entries.filter((entry) => !entry.endsWith("/"));
  const folders = entries.filter((entry) => entry.endsWith("/") && !entries.some((other) => other !== entry && other.startsWith(entry)));
  const walked = await walk(
    root,
    folders.map((folder) => folder.slice(0, -1)),
    unlisted,
    MAX_IGNORED_FILES,
  );
  return {
    files: [...listed.stdout.split("\0").filter(Boolean), ...named.filter(isEnvFile)],
    ignored: [...named.filter((file) => !isEnvFile(file)), ...walked],
  };
}

interface Save {
  path: FolderPath;
  at: number;
}

interface FileServiceDependencies {
  intelligence?: IntelligenceEngine;
  writers: Pick<WorkspaceWriters, "withLease">;
  /** Refresh keys for every window: `workspace-diff` after a save, `files` after a create. */
  invalidate: (keys: string[]) => void;
  formatter: Pick<FileFormatter, "format">;
  /** Signs the viewer URL a binary read carries. Main verifies it with the same key before serving a byte. */
  fileKey: string;
}

/** Ranks a path that holds the query, both lowercase: a basename that starts with it beats one that contains it beats a directory match. */
function heldRank(path: string, query: string): number {
  if (!path.includes(query)) return -1;
  const base = path.slice(path.lastIndexOf("/") + 1);
  if (base === query) return 0;
  if (base.startsWith(query)) return 1;
  return base.includes(query) ? 2 : 3;
}

/** Whether a path has every character of the query in order, the way editors' quick-open matches. */
function inOrder(path: string, query: string): boolean {
  let at = 0;
  for (const character of path) if (character === query[at]) at += 1;
  return at === query.length;
}

/** The paths a rank accepts, best first and shortest first within a rank. */
function ranked(paths: string[], rank: (path: string) => number): string[] {
  return paths
    .map((path) => ({ path, rank: rank(path.toLowerCase()) }))
    .filter((match) => match.rank >= 0)
    .sort((a, b) => a.rank - b.rank || a.path.length - b.path.length)
    .map((match) => match.path);
}

function missing(error: NodeJS.ErrnoException): null {
  if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
  throw error;
}

const FOLDER_NOT_FILE = "This path is a folder, not a file.";
const OUTSIDE_READ_ONLY = "This file is outside this conversation's folder.";

/** Where a file is: its place in the folder, or with `outside` allowed, a file outside it in its own folder. */
function filePlace(root: string, absolute: string, outside: boolean): FilePlace {
  const local = relative(root, absolute);
  if (!local) throw new Error(FOLDER_NOT_FILE);
  if (local !== ".." && !local.startsWith(`..${sep}`) && !isAbsolute(local)) return { root, path: FolderPath.parse(local.split(sep).join("/")), outside: false };
  if (!outside) throw new Error("This file is outside the conversation's workspace.");
  const name = basename(absolute);
  if (!name) throw new Error(FOLDER_NOT_FILE);
  return { root: dirname(absolute), path: FolderPath.parse(name), outside: true };
}

function readOnlyReason(folderReadOnly: string | null, place: FilePlace): string | null {
  if (place.outside) return OUTSIDE_READ_ONLY;
  return folderReadOnly ?? (inGitFolder(place.path) ? "Git's own files are read-only here." : null);
}

/** Whether the first 8000 bytes hold a NUL, as git tells binary from text, so a large binary is known without reading it all. */
async function nulInHead(file: FileHandle): Promise<boolean> {
  const head = Buffer.alloc(8000);
  const { bytesRead } = await file.read(head, 0, head.length, 0);
  return head.subarray(0, bytesRead).includes(0);
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
  readonly intelligence: EditorService;
  /** Listings by folder root, kept for half a minute, so two conversations in one folder, or two searches at once, share one. */
  private readonly listings = new Map<string, { at: number; listing: Promise<Listing> }>();
  /** What the editor saved per folder root, newest last. A turn start reads it to credit changes between turns to the user. */
  private readonly journal = new Map<string, Save[]>();
  /** Real paths of files created here. The bundled formatter may format only these on save. Lost on restart. */
  private readonly created = new Set<string>();
  /** The running find per conversation. A newer one aborts it, which stops its git process. */
  private readonly finds = new Map<string, AbortController>();

  constructor(private readonly deps: FileServiceDependencies) {
    this.intelligence = new EditorService(deps.intelligence ?? null);
  }

  /**
   * A file in the folder, by its place or absolute path. With `outside`, a path outside the folder reads too, read-only
   * in its own folder, as the file panel opens any file a reply links; other callers stay inside the folder.
   */
  async read(folder: Pick<ConversationFolder, "root" | "readOnly">, path: string, options: { outside?: boolean } = {}): Promise<FileRead> {
    if (path.includes("\0")) throw new Error("Invalid file path.");
    const requested = resolve(folder.root, path);
    const target = await realpath(requested).catch(missing);
    const place = filePlace(folder.root, target ?? requested, options.outside ?? false);
    if (!target) return { kind: "missing", ...place };
    const unreadable = (reason: string): FileRead => ({ kind: "unreadable", ...place, reason });
    const file = await open(target, "r");
    try {
      const stat = await file.stat();
      if (!stat.isFile()) return unreadable(FOLDER_NOT_FILE);
      const binary = (media: FileMediaEntry): FileRead => ({
        kind: "binary",
        ...place,
        absolutePath: target,
        size: stat.size,
        ...media,
        url: signFileUrl(this.deps.fileKey, target, `${stat.mtimeMs}-${stat.size}`),
      });
      const known = fileMedia(target);
      if (known) return binary(known);
      if (await nulInHead(file)) return binary(OTHER_MEDIA);
      const bytes = stat.size > MAX_FILE_BYTES ? null : await boundedBytes(file);
      if (!bytes) return unreadable("This file is too large to open (2 MB maximum).");
      if (bytes.includes(0)) return binary(OTHER_MEDIA);
      const text = utf8(bytes);
      if (text === null) return unreadable("This file is not UTF-8 text and cannot be shown.");
      return { kind: "file", ...place, absolutePath: target, version: versionOf(bytes), text, readOnly: readOnlyReason(folder.readOnly, place) };
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

  /**
   * The folder's files that match, best first: those that hold the query, then Git-ignored files that hold it, then
   * files with its characters in order. An ignored file is found by name and never crowds out the rest; ignored folders
   * are too large and too noisy to match loosely.
   */
  async search(folder: Pick<ConversationFolder, "root" | "project">, query: string, limit = 20): Promise<string[]> {
    const { files, ignored } = await this.list(folder);
    const q = query.trim().toLowerCase();
    if (!q) return files.slice(0, limit);
    const found = ranked(files, (path) => heldRank(path, q));
    if (found.length < limit) found.push(...ranked(ignored, (path) => heldRank(path, q)));
    if (found.length < limit) found.push(...ranked(files, (path) => (!path.includes(q) && inOrder(path, q) ? 0 : -1)));
    return found.slice(0, limit);
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
      const files = async () => (await this.list({ root, project })).files.filter((file) => !isEnvFile(file));
      const result = await findInFolder({ root, git, files }, query, newer.signal);
      return newer.signal.aborted ? { kind: "superseded" } : result;
    } finally {
      if (this.finds.get(conversation) === newer) this.finds.delete(conversation);
    }
  }

  private list({ root, project }: Pick<ConversationFolder, "root" | "project">): Promise<Listing> {
    const hit = this.listings.get(root);
    if (hit && Date.now() - hit.at < LISTING_MS) return hit.listing;
    const listing = projectGit({ id: project.id, rootPath: root }).then((kind) => (kind === "none" ? folderFiles(root) : gitFiles(root)));
    const kept = { at: Date.now(), listing };
    this.listings.set(root, kept);
    // A listing that failed is not kept, so the next search tries again.
    listing.catch(() => this.listings.get(root) === kept && this.listings.delete(root));
    return listing;
  }
}
