import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { settings, threads } from "@openorc/db";
import { commitAll, git } from "@openorc/git";
import { FolderPath, type FileScope, type Project } from "@openorc/protocol";
import { OpenOrc } from "./openorc.js";
import { rpcClient } from "./rpc-test-client.js";
import { TypeScriptIntelligence } from "./editor/typescript-intelligence.js";
import type { IntelligenceEngine } from "./editor/worker-intelligence.js";

let root: string;
let checkout: string;
let core: OpenOrc;
let project: Project;
const main = 'import { double } from "./math";\nexport const value = double(2);\n';
const path = FolderPath.parse("main.ts");
const call = rpcClient(() => core);
const engine = { query: vi.fn<IntelligenceEngine["query"]>(), close: vi.fn<IntelligenceEngine["close"]>() };

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "openorc-editor-rpc-")));
  checkout = join(root, "checkout");
  await mkdir(checkout);
  await git(checkout, ["init", "-q", "-b", "main"]);
  await git(checkout, ["config", "user.email", "fixture@example.invalid"]);
  await git(checkout, ["config", "user.name", "Fixture"]);
  await Promise.all([
    writeFile(join(checkout, path), main),
    writeFile(join(checkout, "math.ts"), "export const double = (value: number) => value * 2;\n"),
    writeFile(join(checkout, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, types: [] }, include: ["*.ts"] })),
  ]);
  await commitAll(checkout, "Fixture");
  const language = new TypeScriptIntelligence();
  engine.query.mockReset().mockImplementation(async (input) => language.query(input));
  engine.close.mockReset().mockImplementation(async () => language.dispose());
  core = await OpenOrc.create({ dataDir: join(root, "data"), ephemeral: true, transport: { push() {} }, intelligence: engine });
  settings.set(core.db, "extraction.provider", "off");
  project = await core.projects.import(checkout);
});
afterEach(async () => {
  await core.close();
  await rm(root, { recursive: true, force: true });
});

const query = (scope: FileScope, expectedRoot: string) =>
  call("editor.query", { scope, expectedRoot, path, documents: [{ path, text: main }], query: { kind: "hover", position: main.lastIndexOf("double") + 2 } });

it("uses a thread's actual worktree after analyzing its project's checkout", async () => {
  expect(await query({ kind: "project", id: project.id }, checkout)).toMatchObject({ kind: "hover", info: { display: expect.stringContaining("value: number") } });
  const worktree = join(root, "worktree");
  await git(checkout, ["worktree", "add", "-q", "-b", "apart", worktree]);
  await writeFile(join(worktree, "math.ts"), "export const double = (value: string) => value + value;\n");
  const thread = threads.insert(core.db, { projectId: project.id, title: "Apart", agent: "codex", model: "fixture", mode: "act", permissionMode: "trusted", workspaceMode: "worktree" });
  threads.update(core.db, thread.id, { worktreePath: worktree, branch: "apart" });
  expect(await query({ kind: "thread", id: thread.id }, worktree)).toMatchObject({ kind: "hover", info: { display: expect.stringContaining("value: string") } });
});

it("refuses an old root before sending buffers to the engine", async () => {
  expect(await query({ kind: "project", id: project.id }, join(root, "old"))).toMatchObject({ kind: "unavailable", reason: expect.stringContaining("changed workspace") });
  expect(engine.query).not.toHaveBeenCalled();
});

it("validates that the requested cursor belongs to the supplied current buffer", async () => {
  await expect(
    call("editor.query", { scope: { kind: "project", id: project.id }, expectedRoot: checkout, path, documents: [{ path, text: main }], query: { kind: "definition", position: main.length + 1 } }),
  ).rejects.toThrow("cursor");
  expect(engine.query).not.toHaveBeenCalled();
});
