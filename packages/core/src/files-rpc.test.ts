import { createHash } from "node:crypto";
import { access, chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { settings, tasks, threads } from "@openorc/db";
import { commitAll, git } from "@openorc/git";
import { FileVersion, FolderPath, WORKSPACE_ID, type CorePush, type FileExpectation, type FileScope, type Project, type Thread } from "@openorc/protocol";
import { OpenOrc } from "./openorc.js";
import { rpcClient } from "./rpc-test-client.js";

let root: string;
let checkout: string;
let core: OpenOrc;
let project: Project;
let thread: Thread;
let pushed: CorePush[];
const call = rpcClient(() => core);
const conversation = { agent: "codex" as const, model: "fixture", mode: "act" as const, permissionMode: "trusted" as const };
const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
/** Stands in for the bundled Prettier, in process. */
const bundled = { format: async (text: string) => `// bundled\n${text}` };

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "openorc-files-rpc-")));
  checkout = path.join(root, "app");
  await mkdir(checkout);
  await git(checkout, ["init", "-q", "-b", "main"]);
  await git(checkout, ["config", "user.email", "fixture@example.com"]);
  await git(checkout, ["config", "user.name", "Fixture"]);
  await writeFile(path.join(checkout, "README.md"), "# In the checkout\n");
  await commitAll(checkout, "Fixture baseline");
  pushed = [];
  core = await OpenOrc.create({ dataDir: path.join(root, "data"), ephemeral: true, transport: { push: (message) => pushed.push(message) }, formatter: bundled });
  settings.set(core.db, "extraction.provider", "off");
  project = await core.projects.import(checkout);
  thread = threads.insert(core.db, { projectId: project.id, title: "In the checkout", ...conversation });
});
afterEach(async () => {
  await core.close();
  await rm(root, { recursive: true, force: true });
});

/** A thread in its own git worktree, holding one file the checkout doesn't have. */
async function worktreeThread(): Promise<{ thread: Thread; worktree: string }> {
  const worktree = path.join(root, "worktree");
  await git(checkout, ["worktree", "add", "-q", "-b", "openorc/apart", worktree]);
  await writeFile(path.join(worktree, "only-in-worktree.ts"), "export {};\n");
  await writeFile(path.join(worktree, "README.md"), "# In the worktree\n");
  const apart = threads.insert(core.db, { projectId: project.id, title: "Apart", ...conversation, workspaceMode: "worktree" });
  return { thread: threads.update(core.db, apart.id, { worktreePath: worktree, branch: "openorc/apart" }), worktree };
}

it("searches a worktree thread's own folder, after searching the checkout of the same project", async () => {
  expect(await call("files.search", { scope: { kind: "thread", id: thread.id }, query: "only" })).toEqual([]);
  const { thread: apart } = await worktreeThread();
  expect(await call("files.search", { scope: { kind: "thread", id: apart.id }, query: "only" })).toEqual(["only-in-worktree.ts"]);
});

it("lists immediate folders and files, including empty, ignored and hidden entries, folders first", async () => {
  await mkdir(path.join(checkout, "src"));
  await mkdir(path.join(checkout, "empty"));
  await mkdir(path.join(checkout, "node_modules"));
  await writeFile(path.join(checkout, "src", "index.ts"), "export {};\n");
  await writeFile(path.join(checkout, ".gitignore"), "node_modules/\n");
  const scope = { kind: "thread", id: thread.id } as const;
  const listing = await call("files.list", { scope, path: "" });
  expect(listing.root).toBe(checkout);
  expect(listing.entries.map((entry) => [entry.name, entry.kind])).toEqual([
    [".git", "directory"],
    ["empty", "directory"],
    ["node_modules", "directory"],
    ["src", "directory"],
    [".gitignore", "file"],
    ["README.md", "file"],
  ]);
  expect(listing.entries.filter((entry) => entry.ignored).map((entry) => entry.name)).toEqual([".git", "node_modules"]);
  expect(await call("files.list", { scope, path: FolderPath.parse("src") })).toEqual({ root: checkout, entries: [{ name: "index.ts", path: "src/index.ts", kind: "file", ignored: false }] });
  expect((await call("files.list", { scope, path: FolderPath.parse("empty") })).entries).toEqual([]);
});

it("lists the worktree and the task's execution folder rather than the checkout", async () => {
  const { thread: apart, worktree } = await worktreeThread();
  const task = tasks.insert(core.db, { projectId: project.id, title: "Run apart", spec: null, priority: "none", labels: [], workspaceMode: "worktree", baseRef: null, parentTaskId: null });
  tasks.update(core.db, task.id, { executionThreadId: apart.id });
  for (const scope of [
    { kind: "thread", id: apart.id },
    { kind: "task", id: task.id },
  ] as const) {
    const listing = await call("files.list", { scope, path: "" });
    expect(listing.root).toBe(worktree);
    expect(listing.entries.some((entry) => entry.name === "only-in-worktree.ts")).toBe(true);
  }
});

it("does not list folders through a symlink outside the workspace, but allows internal directory links", async () => {
  const outside = path.join(root, "private");
  await mkdir(outside);
  await writeFile(path.join(outside, "secret.txt"), "secret");
  await mkdir(path.join(checkout, "src"));
  await writeFile(path.join(checkout, "src", "index.ts"), "export {};\n");
  await symlink(outside, path.join(checkout, "external"));
  await symlink(path.join(checkout, "src"), path.join(checkout, "alias"));
  const scope = { kind: "thread", id: thread.id } as const;
  expect((await call("files.list", { scope, path: "" })).entries.some((entry) => entry.name === "external")).toBe(false);
  await expect(call("files.list", { scope, path: FolderPath.parse("external") })).rejects.toThrow("outside");
  expect((await call("files.list", { scope, path: FolderPath.parse("alias") })).entries).toEqual([{ name: "index.ts", path: "alias/index.ts", kind: "file", ignored: false }]);
});

it("marks Git ignore rules and metadata without hiding tracked files or useful dot folders", async () => {
  for (const directory of [".github", "output", "src"]) await mkdir(path.join(checkout, directory));
  await writeFile(path.join(checkout, ".gitignore"), "output/\n*.log\nREADME.md\n");
  await writeFile(path.join(checkout, ".DS_Store"), "metadata");
  await writeFile(path.join(checkout, "src", ".gitignore"), "!keep.log\n");
  await writeFile(path.join(checkout, "src", "debug.log"), "ignored");
  await writeFile(path.join(checkout, "src", "keep.log"), "included");
  const scope = { kind: "thread", id: thread.id } as const;
  const rootEntries = (await call("files.list", { scope, path: "" })).entries;
  expect(rootEntries.filter((entry) => entry.ignored).map((entry) => entry.name)).toEqual([".git", "output", ".DS_Store"]);
  expect(rootEntries.filter((entry) => !entry.ignored).map((entry) => entry.name)).toEqual([".github", "src", ".gitignore", "README.md"]);
  const sourceEntries = (await call("files.list", { scope, path: FolderPath.parse("src") })).entries;
  expect(sourceEntries.filter((entry) => entry.ignored).map((entry) => entry.name)).toEqual(["debug.log"]);
});

it("searches the folder a Workspace conversation chose", async () => {
  const chosen = path.join(root, "notes");
  await mkdir(chosen);
  await writeFile(path.join(chosen, "ideas.md"), "# Ideas\n");
  const notes = threads.insert(core.db, { projectId: WORKSPACE_ID, title: "Notes", ...conversation });
  threads.update(core.db, notes.id, { workingDirectory: chosen });
  expect(await call("files.search", { scope: { kind: "thread", id: notes.id }, query: "" })).toEqual(["ideas.md"]);
  await mkdir(path.join(chosen, "node_modules"));
  const listing = await call("files.list", { scope: { kind: "thread", id: notes.id }, path: "" });
  expect(listing.entries.map((entry) => [entry.name, entry.ignored])).toEqual([
    ["node_modules", true],
    ["ideas.md", false],
  ]);
});

const read = (file: string) => call("files.read", { scope: { kind: "thread", id: thread.id }, path: file });

it("versions a file by the sha256 of its bytes, byte order mark included, and leaves the mark out of its text", async () => {
  const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("# Notes\r\n")]);
  await writeFile(path.join(checkout, "notes.md"), bytes);
  expect(await read("notes.md")).toEqual({
    kind: "file",
    root: checkout,
    path: "notes.md",
    absolutePath: path.join(checkout, "notes.md"),
    version: createHash("sha256").update(bytes).digest("hex"),
    text: "# Notes\r\n",
    readOnly: null,
  });
});

it("names the folder each read came from, shared by conversations in one checkout and apart for a worktree", async () => {
  const beside = threads.insert(core.db, { projectId: project.id, title: "Beside", ...conversation });
  const { thread: apart, worktree } = await worktreeThread();
  const rootOf = async (id: string) => (await call("files.read", { scope: { kind: "thread", id }, path: "README.md" })).root;
  expect([await rootOf(thread.id), await rootOf(beside.id), await rootOf(apart.id)]).toEqual([checkout, checkout, worktree]);
});

it("answers a file that isn't there with its place in the folder, however the link named it", async () => {
  expect(await read("src/gone.ts")).toEqual({ kind: "missing", root: checkout, path: "src/gone.ts" });
  expect(await read(path.join(checkout, "gone.ts"))).toEqual({ kind: "missing", root: checkout, path: "gone.ts" });
  expect(await read("README.md/child")).toEqual({ kind: "missing", root: checkout, path: "README.md/child" });
});

it("answers a folder, a non-UTF-8 and an oversized file as unreadable, and a binary with a viewer URL, never their contents", async () => {
  await mkdir(path.join(checkout, "src"));
  await writeFile(path.join(checkout, "logo.png"), Buffer.from([0x89, 0x50, 0x00, 0x47]));
  await writeFile(path.join(checkout, "latin1.txt"), Buffer.from("café", "latin1"));
  await writeFile(path.join(checkout, "dump.sql"), Buffer.alloc(2 * 1024 * 1024 + 1, "a"));
  for (const file of ["src", "latin1.txt", "dump.sql"]) expect(await read(file)).toEqual({ kind: "unreadable", root: checkout, path: file, reason: expect.any(String) });
  expect(await read("logo.png")).toEqual({
    kind: "binary",
    root: checkout,
    path: "logo.png",
    absolutePath: path.join(checkout, "logo.png"),
    size: 4,
    media: "image",
    mime: "image/png",
    url: expect.stringMatching(/^openorc-file:\/\/file\/\?path=[^&]+&sig=[a-f0-9]{64}&v=[^&]+$/),
  });
});

it("names the file a symlink points at, so a file has one path however it was opened", async () => {
  await writeFile(path.join(checkout, "real.ts"), "export {};\n");
  await symlink(path.join(checkout, "real.ts"), path.join(checkout, "alias.ts"));
  expect(await read("alias.ts")).toMatchObject({ kind: "file", path: "real.ts", absolutePath: path.join(checkout, "real.ts"), text: "export {};\n" });
});

it("refuses paths outside the folder, whether absolute, climbing out, through a symlink or missing", async () => {
  const outside = path.join(root, "secret.txt");
  await writeFile(outside, "secret");
  await symlink(outside, path.join(checkout, "leak.txt"));
  for (const file of [outside, "../secret.txt", "leak.txt", path.join(root, "nowhere.txt")]) await expect(read(file)).rejects.toThrow("outside");
});

it("reads Git's own files as read-only", async () => {
  expect(await read(".git/HEAD")).toMatchObject({ kind: "file", path: ".git/HEAD", readOnly: expect.any(String) });
  expect(await read("README.md")).toMatchObject({ kind: "file", readOnly: null });
});

it("reads a task started in a conversation from that conversation's worktree", async () => {
  const { thread: apart } = await worktreeThread();
  const task = tasks.insert(core.db, { projectId: project.id, title: "Run apart", spec: null, priority: "none", labels: [], workspaceMode: "worktree", baseRef: null, parentTaskId: null });
  tasks.update(core.db, task.id, { executionThreadId: apart.id });
  expect(await call("files.read", { scope: { kind: "task", id: task.id }, path: "README.md" })).toMatchObject({ kind: "file", text: "# In the worktree\n" });
});

const write = (file: string, text: string, expected: FileExpectation, scope: FileScope = { kind: "thread", id: thread.id }) =>
  call("files.write", { scope, path: FolderPath.parse(file), text, expected });
const invalidations = () => pushed.flatMap((message) => (message.type === "invalidate" ? [message.keys] : []));
const leftovers = async (folder: string) => (await readdir(folder)).filter((name) => name.startsWith(".openorc-"));

/** The version a save must expect, read the way the editor reads it. */
async function versionOf(file: string) {
  const current = await read(file);
  if (current.kind !== "file") throw new Error(`${file} is ${current.kind}`);
  return current.version;
}

it("saves a file that is still as read, answers with a version the next read agrees with, and refreshes the diff views", async () => {
  const version = await versionOf("README.md");
  pushed = [];
  const saved = await write("README.md", "# Mine\n", { kind: "version", version });
  expect(saved).toEqual({ kind: "saved", root: checkout, path: "README.md", absolutePath: path.join(checkout, "README.md"), version: sha256("# Mine\n"), text: null, formatError: null });
  expect(await read("README.md")).toMatchObject({ kind: "file", text: "# Mine\n", version: saved.kind === "saved" ? saved.version : null });
  expect(invalidations()).toEqual([["workspace-diff"]]);
  expect(core.db.stmt("SELECT COUNT(*) AS count FROM audit_events WHERE action = 'files.write'").get()).toMatchObject({ count: 1 });
});

it("refuses a save whose expected version is stale, answers with the file as it is now, and touches neither the disk nor the views", async () => {
  const version = await versionOf("README.md");
  await writeFile(path.join(checkout, "README.md"), "# The agent's edit\n");
  pushed = [];
  const refused = await write("README.md", "# Mine\n", { kind: "version", version });
  expect(refused).toMatchObject({ kind: "conflict", current: { kind: "file", path: "README.md", text: "# The agent's edit\n", version: sha256("# The agent's edit\n") } });
  expect(await readFile(path.join(checkout, "README.md"), "utf8")).toBe("# The agent's edit\n");
  expect(await leftovers(checkout)).toEqual([]);
  expect(invalidations()).toEqual([]);
  expect(core.db.stmt("SELECT COUNT(*) AS count FROM audit_events WHERE action = 'files.write'").get()).toMatchObject({ count: 0 });
});

it("creates a file only where nothing is: of two concurrent creates one lands, the other sees the file, and quick open learns of it", async () => {
  const scope = { kind: "thread" as const, id: thread.id };
  expect(await call("files.search", { scope, query: "new" })).toEqual([]);
  pushed = [];
  const outcomes = await Promise.all([write("src/new.ts", "a\n", { kind: "absent" }), write("src/new.ts", "b\n", { kind: "absent" })]);
  expect(outcomes.map((outcome) => outcome.kind).sort()).toEqual(["conflict", "saved"]);
  const text = await readFile(path.join(checkout, "src", "new.ts"), "utf8");
  expect(["a\n", "b\n"]).toContain(text);
  expect(outcomes.find((outcome) => outcome.kind === "conflict")).toMatchObject({ current: { kind: "file", text } });
  expect(await leftovers(path.join(checkout, "src"))).toEqual([]);
  expect(invalidations()).toEqual([["workspace-diff", "files"]]);
  expect(await call("files.search", { scope, query: "new" })).toEqual(["src/new.ts"]);
});

it("keeps the file's mode and byte order mark across a save, counts the mark in the version, and leaves no temp file", async () => {
  const bytes = Buffer.concat([BOM, Buffer.from("#!/bin/sh\necho hi\n")]);
  await writeFile(path.join(checkout, "run.sh"), bytes);
  await chmod(path.join(checkout, "run.sh"), 0o755);
  const saved = await write("run.sh", "#!/bin/sh\necho bye\n", { kind: "version", version: FileVersion.parse(sha256(bytes)) });
  const after = await readFile(path.join(checkout, "run.sh"));
  expect(after).toEqual(Buffer.concat([BOM, Buffer.from("#!/bin/sh\necho bye\n")]));
  expect(saved).toMatchObject({ kind: "saved", version: sha256(after) });
  expect((await stat(path.join(checkout, "run.sh"))).mode & 0o777).toBe(0o755);
  expect(await leftovers(checkout)).toEqual([]);
});

it("writes the file a link points at, as read names it, leaves the link a link, and refuses the link's own path", async () => {
  await writeFile(path.join(checkout, "real.ts"), "export {};\n");
  await symlink(path.join(checkout, "real.ts"), path.join(checkout, "alias.ts"));
  const opened = await read("alias.ts");
  if (opened.kind !== "file") throw new Error("alias.ts did not open");
  expect(await write(opened.path, "export const x = 1;\n", { kind: "version", version: opened.version })).toMatchObject({ kind: "saved", path: "real.ts" });
  expect(await readFile(path.join(checkout, "real.ts"), "utf8")).toBe("export const x = 1;\n");
  expect((await lstat(path.join(checkout, "alias.ts"))).isSymbolicLink()).toBe(true);
  await expect(write("alias.ts", "export const x = 2;\n", { kind: "version", version: opened.version })).rejects.toThrow("now a link");
  expect(await readFile(path.join(checkout, "real.ts"), "utf8")).toBe("export const x = 1;\n");
});

it("refuses Git's own files and paths under a symlinked folder, writing nothing", async () => {
  await mkdir(path.join(root, "elsewhere"));
  await symlink(path.join(root, "elsewhere"), path.join(checkout, "linked"));
  await expect(write(".git/hooks/pre-commit", "exit 1\n", { kind: "absent" })).rejects.toThrow("Git's own files are read-only here.");
  await expect(access(path.join(checkout, ".git", "hooks", "pre-commit"))).rejects.toThrow();
  await expect(write("linked/x.ts", "x", { kind: "absent" })).rejects.toThrow("Unsafe");
  await expect(access(path.join(root, "elsewhere", "x.ts"))).rejects.toThrow();
  expect(invalidations()).toEqual([]);
});

it("saves where the resolver points: a project's checkout before any conversation, and a Workspace conversation's chosen folder", async () => {
  expect(await write("notes.md", "# Project notes\n", { kind: "absent" }, { kind: "project", id: project.id })).toMatchObject({ kind: "saved", absolutePath: path.join(checkout, "notes.md") });
  expect(await readFile(path.join(checkout, "notes.md"), "utf8")).toBe("# Project notes\n");
  const chosen = path.join(root, "notes");
  await mkdir(chosen);
  const notes = threads.insert(core.db, { projectId: WORKSPACE_ID, title: "Notes", ...conversation });
  threads.update(core.db, notes.id, { workingDirectory: chosen });
  expect(await write("ideas.md", "# Ideas\n", { kind: "absent" }, { kind: "thread", id: notes.id })).toMatchObject({ kind: "saved", absolutePath: path.join(chosen, "ideas.md") });
  expect(await readFile(path.join(chosen, "ideas.md"), "utf8")).toBe("# Ideas\n");
});

it("journals what it saved under the folder root, each path once, and marks only created files by their real path", async () => {
  const since = Date.now();
  await write("README.md", "# One\n", { kind: "version", version: await versionOf("README.md") });
  await write("README.md", "# Two\n", { kind: "version", version: await versionOf("README.md") });
  await write("src/new.ts", "export {};\n", { kind: "absent" });
  expect(core.files.savedSince(checkout, since).sort()).toEqual(["README.md", "src/new.ts"]);
  expect(core.files.savedSince(checkout, Date.now() + 1)).toEqual([]);
  expect(core.files.savedSince(root, since)).toEqual([]);
  expect(core.files.createdHere(path.join(checkout, "src", "new.ts"))).toBe(true);
  expect(core.files.createdHere(path.join(checkout, "README.md"))).toBe(false);
});

/** The project's own Prettier, standing in as a script that uppercases stdin and notes each run in `ran`. */
async function projectPrettier(folder: string, body = "tr '[:lower:]' '[:upper:]'") {
  await writeFile(path.join(folder, ".prettierrc"), "{}\n");
  await mkdir(path.join(folder, "node_modules", ".bin"), { recursive: true });
  await writeFile(path.join(folder, "node_modules", ".bin", "prettier"), `#!/bin/sh\necho run >> "${path.join(root, "ran")}"\n${body}\n`, { mode: 0o755 });
}

it("formats an existing file with the project's own formatter on save, and answers with the text it wrote", async () => {
  await projectPrettier(checkout);
  const saved = await write("README.md", "# mine\n", { kind: "version", version: await versionOf("README.md") });
  expect(saved).toMatchObject({ kind: "saved", version: sha256("# MINE\n"), text: "# MINE\n", formatError: null });
  expect(await readFile(path.join(checkout, "README.md"), "utf8")).toBe("# MINE\n");
});

it("saves an existing file as typed without a project formatter, and formats one created here with the bundled formatter", async () => {
  expect(await write("README.md", "# mine\n", { kind: "version", version: await versionOf("README.md") })).toMatchObject({ kind: "saved", text: null, formatError: null });
  expect(await readFile(path.join(checkout, "README.md"), "utf8")).toBe("# mine\n");
  await write("src/new.ts", "", { kind: "absent" });
  expect(await write("src/new.ts", "export {};\n", { kind: "version", version: await versionOf("src/new.ts") })).toMatchObject({ kind: "saved", text: "// bundled\nexport {};\n" });
  expect(await readFile(path.join(checkout, "src", "new.ts"), "utf8")).toBe("// bundled\nexport {};\n");
});

it("formats any file on request, with the bundled formatter when the project has none, and writes nothing", async () => {
  pushed = [];
  const format = (text: string) => call("files.format", { scope: { kind: "thread", id: thread.id }, path: FolderPath.parse("README.md"), text });
  expect(await format("# Mine\n")).toEqual({ kind: "formatted", text: "// bundled\n# Mine\n" });
  await projectPrettier(checkout);
  expect(await format("# Mine\n")).toEqual({ kind: "formatted", text: "# MINE\n" });
  expect(await format("# MINE\n")).toEqual({ kind: "unchanged" });
  expect(await readFile(path.join(checkout, "README.md"), "utf8")).toBe("# In the checkout\n");
  expect(invalidations()).toEqual([]);
});

it("never runs a project's formatter in a pull request copy", async () => {
  const { thread: copy, worktree } = await worktreeThread();
  threads.update(core.db, copy.id, { branch: null });
  await projectPrettier(worktree);
  const scope = { kind: "thread" as const, id: copy.id };
  expect(await call("files.format", { scope, path: FolderPath.parse("README.md"), text: "# mine\n" })).toEqual({ kind: "unavailable" });
  await expect(write("README.md", "# mine\n", { kind: "version", version: FileVersion.parse(sha256("# In the worktree\n")) }, scope)).rejects.toThrow("read-only");
  await expect(access(path.join(root, "ran"))).rejects.toThrow();
});

it("saves the text as typed when the formatter fails, and says why", async () => {
  await projectPrettier(checkout, "echo '[error] README.md: SyntaxError: Unexpected token (1:3)' >&2; exit 2");
  const saved = await write("README.md", "# mine\n", { kind: "version", version: await versionOf("README.md") });
  expect(saved).toMatchObject({ kind: "saved", version: sha256("# mine\n"), text: null, formatError: "Prettier: [error] README.md: SyntaxError: Unexpected token (1:3)" });
  expect(await readFile(path.join(checkout, "README.md"), "utf8")).toBe("# mine\n");
});
