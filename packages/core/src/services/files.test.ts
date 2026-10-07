import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { FolderPath } from "@openorc/protocol";
import { FileFormatter } from "./file-format.js";
import { FileService } from "./files.js";
import { WorkspaceWriters } from "./workspace-writers.js";

let dir: string;
let root: string;
let writers: WorkspaceWriters;
let files: FileService;
beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "openorc-files-")));
  root = join(dir, "workspace");
  await mkdir(root);
  writers = new WorkspaceWriters();
  const formatter = new FileFormatter({ bundled: null, environment: () => ({ path: join(dir, "bin"), env: { PATH: "/usr/bin:/bin" } }), timeoutMs: 500 });
  files = new FileService({ writers, invalidate: () => {}, formatter });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

it("offers a folder's files without git, skipping hidden entries and dependency or build output", async () => {
  for (const folder of ["src", ".cache", "node_modules/lib", "dist"]) await mkdir(join(root, folder), { recursive: true });
  for (const file of ["plan.md", "src/app.ts", ".env", ".cache/entry", "node_modules/lib/index.js", "dist/app.js"]) await writeFile(join(root, file), "x");
  const project = {
    id: "plain",
    name: "workspace",
    rootPath: root,
    gitRemote: null,
    defaultBranch: null,
    settings: { setupScript: null, worktreeInclude: [], branchPrefix: "openorc/", detectedConfigs: [] },
    createdAt: 0,
    updatedAt: 0,
  };
  expect((await files.search({ root, project }, "")).sort()).toEqual(["plan.md", "src/app.ts"]);
  expect(await files.search({ root, project }, "app")).toEqual(["src/app.ts"]);
});

const absent = { kind: "absent" as const };
const editable = () => ({ root, readOnly: null, kind: "checkout" as const });
const saving = (path: string, text: string) => ({ path: FolderPath.parse(path), text, expected: absent, format: true });

it("refuses to write in a folder the resolver marked read-only, and writes nothing there", async () => {
  await expect(files.write({ root, readOnly: "Pull request copies are read-only.", kind: "review" }, saving("notes.md", "x"))).rejects.toThrow("Pull request copies are read-only.");
  await expect(readFile(join(root, "notes.md"))).rejects.toThrow();
});

it("stops a formatter that hangs at the timeout and saves the text as typed, saying why", async () => {
  await writeFile(join(root, "go.mod"), "module example.com/app\n");
  await mkdir(join(dir, "bin"));
  await writeFile(join(dir, "bin", "gofmt"), "#!/bin/sh\nexec sleep 30\n", { mode: 0o755 });
  const started = Date.now();
  const saved = await files.write(editable(), saving("main.go", "package main\n"));
  expect(saved).toMatchObject({ kind: "saved", text: null, formatError: "gofmt: it took longer than 0.5 seconds and was stopped" });
  expect(await readFile(join(root, "main.go"), "utf8")).toBe("package main\n");
  expect(Date.now() - started).toBeLessThan(5_000);
});

it("waits for an exclusive operation on the folder to finish instead of racing it, without asking idle agents to yield", async () => {
  let yields = 0;
  writers.onConflict(async () => {
    yields += 1;
    return false;
  });
  const commit = await writers.acquire(root, "committing");
  let settled = false;
  const pending = files.write(editable(), saving("notes.md", "written after the commit\n")).finally(() => {
    settled = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 400));
  expect(settled).toBe(false);
  commit.release();
  await expect(pending).resolves.toMatchObject({ kind: "saved" });
  expect(await readFile(join(root, "notes.md"), "utf8")).toBe("written after the commit\n");
  expect(yields).toBe(0);
});

it("saves beside an agent's shared lease without waiting, and gives up on an exclusive one held past the save wait", async () => {
  const run = await writers.acquire(root, "run", undefined, { shared: true });
  await expect(files.write(editable(), saving("beside.md", "x"))).resolves.toMatchObject({ kind: "saved" });
  run.release();
  const restore = await writers.acquire(root, "restoring");
  await expect(files.write(editable(), saving("blocked.md", "x"))).rejects.toThrow(/in use by restoring/);
  restore.release();
  await expect(readFile(join(root, "blocked.md"))).rejects.toThrow();
}, 15_000);
