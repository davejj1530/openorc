import { z } from "zod";

/**
 * A conversation, by id. File methods never carry folder paths: the core resolves the folder on every call with the
 * rule run launch uses, so they always see the folder the conversation's agent works in.
 */
export const ConversationScope = z.object({ kind: z.enum(["thread", "task"]), id: z.string().min(1) }).strict();
export type ConversationScope = z.infer<typeof ConversationScope>;

/** A project's folder before any conversation exists: its checkout, or the folder a new Workspace conversation will use. */
export const ProjectScope = z.object({ kind: z.literal("project"), id: z.string().min(1), workingDirectory: z.string().min(1).optional() }).strict();
export type ProjectScope = z.infer<typeof ProjectScope>;

/** Where file methods look: a conversation's folder, or a project's before the conversation starts. */
export const FileScope = z.union([ConversationScope, ProjectScope]);
export type FileScope = z.infer<typeof FileScope>;

/** sha256 of a file's bytes on disk, lowercase hex. Equal versions mean byte-identical files, byte order mark included. */
export const FileVersion = z
  .string()
  .regex(/^[0-9a-f]{64}$/)
  .brand<"FileVersion">();
export type FileVersion = z.infer<typeof FileVersion>;

const isFolderPath = (value: string) => !value.includes("\0") && !/^[/\\]/.test(value) && value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");

/** A file's place inside a conversation's folder: relative, `/`-separated, with no empty, `.` or `..` segment. */
export const FolderPath = z.string().min(1).max(4096).refine(isFolderPath, "Use a path inside the conversation's folder, such as src/index.ts.").brand<"FolderPath">();
export type FolderPath = z.infer<typeof FolderPath>;

/** Git's own files, under a `.git` segment in any case. They open read-only and are never written. */
export const inGitFolder = (path: string): boolean => /(^|\/)\.git(\/|$)/i.test(path);

export interface FileSnapshot {
  /** The folder's real path. With `path` it names one file across conversations, as the editor keys drafts. */
  root: string;
  /** The real file's place in the folder: a link to a symlink answers with the file it points at. */
  path: FolderPath;
  absolutePath: string;
  version: FileVersion;
  /** UTF-8 without a byte order mark. Line endings are as on disk. */
  text: string;
  /** Null when the user may edit the file. Otherwise why not. */
  readOnly: string | null;
}

export type FileRead = ({ kind: "file" } & FileSnapshot) | { kind: "missing"; root: string; path: FolderPath } | { kind: "unreadable"; root: string; path: FolderPath; reason: string };

/** What a save expects on disk: the version the edit started from, or no file at all, which makes the write create-only. */
export const FileExpectation = z.discriminatedUnion("kind", [z.object({ kind: z.literal("version"), version: FileVersion }).strict(), z.object({ kind: z.literal("absent") }).strict()]);
export type FileExpectation = z.infer<typeof FileExpectation>;

/**
 * A save's outcome. `saved.text` is what was written when formatting changed it, null when it is the text sent; with a
 * `formatError` the formatter failed and the text was saved as typed. `conflict.current` is the file as it is now, so
 * the editor can show the banner without another round trip.
 */
export type FileWriteResult =
  { kind: "saved"; root: string; path: FolderPath; absolutePath: string; version: FileVersion; text: string | null; formatError: string | null } | { kind: "conflict"; current: FileRead };

/** An explicit format, which saves nothing. `unavailable`: no formatter applies to this file in this folder. */
export type FormatResult = { kind: "formatted"; text: string } | { kind: "unchanged" } | { kind: "unavailable" } | { kind: "failed"; message: string };

/** What to find in a folder's files: literal text by default, or a regular expression. */
export const FindQuery = z.object({ text: z.string().min(1).max(500), regex: z.boolean(), caseSensitive: z.boolean() }).strict();
export type FindQuery = z.infer<typeof FindQuery>;

/** One matching line, cut to show its first match. */
export interface FindLine {
  line: number;
  text: string;
}

/** One file's matching lines, in order. Shaped like a search tool's output, so one view shows both. */
export interface FindGroup {
  path: string;
  lines: FindLine[];
}

/**
 * `matches`: lines grouped by file, with `truncated` set when more matched than came back.
 * `superseded`: a newer find for the same conversation started, so this one stopped.
 * `invalid`: the folder's search can't read the regular expression.
 */
export type FindResult = { kind: "matches"; groups: FindGroup[]; truncated: boolean } | { kind: "superseded" } | { kind: "invalid"; message: string };

/** Same bound as reads, in characters. The core checks the encoded bytes again, since one character can take four. */
const MAX_TEXT = 2 * 1024 * 1024;

export const fileRpcParams = {
  /** File names in a conversation's folder or a project's checkout, best first, for @ mentions. */
  "files.search": z.object({ scope: FileScope, query: z.string().max(500), limit: z.number().int().positive().max(50).optional() }).strict(),
  /** A text file in the conversation's folder, with its version. `path` may be relative to the folder or absolute inside it. */
  "files.read": z.object({ scope: FileScope, path: z.string().min(1).max(4096) }).strict(),
  /**
   * Saves editor text if the file is still as `expected`, formatted first by the project's formatter, or by the bundled
   * one for a file created here. With `absent`, creates the file and never replaces one.
   */
  "files.write": z.object({ scope: FileScope, path: FolderPath, text: z.string().max(MAX_TEXT), expected: FileExpectation }).strict(),
  /** Lines matching `query` in the folder's files, grouped by file. A newer find for the same conversation stops this one. */
  "files.find": z.object({ scope: FileScope, query: FindQuery }).strict(),
  /** The text as the file's formatter would write it: the project's own, else the bundled Prettier. Touches nothing on disk. */
  "files.format": z.object({ scope: FileScope, path: FolderPath, text: z.string().max(MAX_TEXT) }).strict(),
};

export type FileMethod = keyof typeof fileRpcParams;

export interface FileRpcResults {
  "files.search": string[];
  "files.read": FileRead;
  "files.write": FileWriteResult;
  "files.find": FindResult;
  "files.format": FormatResult;
}

/** Cached reads, which need refresh tags, and actions, called on demand and never cached. Every files.* method is in exactly one. */
export const fileReads = ["files.read", "files.search", "files.find"] as const satisfies readonly FileMethod[];
export const fileActions = ["files.write", "files.format"] as const satisfies readonly FileMethod[];
export type FileReadMethod = (typeof fileReads)[number];
export type FileActionMethod = (typeof fileActions)[number];
/** Fails to compile when a files.* method is in neither list. */
export const filesAreClassified: [Exclude<FileMethod, FileReadMethod | FileActionMethod>] extends [never] ? true : never = true;
