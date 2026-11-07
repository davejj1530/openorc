import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { brainLayout, bundleBranch, LocalSandboxProvider, newBrainKey, sealHandover, type BrainControlRequest, type BrainLayout, type BrainStart } from "@openorc/cloud";
import { OpenOrc } from "@openorc/core";
import { relocations, threads } from "@openorc/db";
import { commitAll, git, worktree } from "@openorc/git";
import { DEFAULT_CLAUDE_ACCOUNT, MOVING_WORDS, type Project } from "@openorc/protocol";
import { NO_SANDBOX } from "./awake.js";
import { controlHandlers } from "./control-ops.js";
import { BrainCloud, CLOUD_CHANNEL } from "./cloud.js";
import { BrainGitHub, GITHUB_CHANNEL } from "./github.js";
import { brainOptions } from "./options.js";
import { SealedSecrets } from "./secrets.js";

let root: string;
let layout: BrainLayout;
let start: BrainStart;
let brain: OpenOrc;
let mac: OpenOrc;
let checkout: string;
let project: Project;
let ops: (request: BrainControlRequest) => Promise<unknown>;

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "openorc-brain-relocation-")));
  layout = brainLayout(path.join(root, "brain"));
  start = { key: newBrainKey(), name: "Cloud", address: "localhost", port: 0, vercel: null };
  const secrets = await SealedSecrets.open(layout.secrets, start.key);
  const github = new BrainGitHub(secrets.store(GITHUB_CHANNEL), () => undefined);
  const cloud = new BrainCloud({ store: secrets.store(CLOUD_CHANNEL), start, self: NO_SANDBOX, warn: () => undefined });
  const options = brainOptions({ layout, appDir: path.join(root, "app", "v1"), start, cloud, secrets, transport: { push: () => {} }, runnerFiles: [] });
  brain = await OpenOrc.create({ ...options, ephemeral: true, cloudSandboxes: new LocalSandboxProvider(path.join(root, "sandboxes"), () => process.env, 1500) });
  ops = controlHandlers({ core: brain, key: start.key, layout, github, cloud, stop: () => undefined, answering: () => false }) as (request: BrainControlRequest) => Promise<unknown>;
  await ops(sealHandover(start.key, { claude: { accounts: [{ id: DEFAULT_CLAUDE_ACCOUNT, name: "Personal", default: true, token: "sk-ant-oat01-fixture" }] } }));
  checkout = path.join(root, "mac-repo", "app");
  await mkdir(checkout, { recursive: true });
  await git(checkout, ["init", "-q", "-b", "main"]);
  await writeFile(path.join(checkout, "README.md"), "# Relocation\n");
  await commitAll(checkout, "Baseline");
  mac = await OpenOrc.create({ dataDir: path.join(root, "mac"), ephemeral: true, transport: { push: () => {} } });
  project = await mac.projects.import(checkout);
  const { bytes } = await bundleBranch(checkout, "main", null);
  await mkdir(layout.inbox, { recursive: true });
  await writeFile(path.join(layout.inbox, "copy.bundle"), bytes);
  await ops({ op: "import-project", source: project.id, name: "app", branch: "main", bundle: "copy.bundle" });
});

afterEach(async () => {
  await brain.close();
  await mac.close();
  // The brain may still be seeding a thread's sandbox, and git writing objects, as the folder goes.
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

/** A Mac thread on a branch of its own with a commit, as a turn would leave it. */
async function macThread(title: string): Promise<string> {
  const thread = threads.insert(mac.db, { projectId: project.id, title, agent: "claude", model: null, mode: "act", permissionMode: "autonomous", workspaceMode: "worktree" });
  const folder = path.join(root, "mac", "worktrees", thread.id);
  const branch = `openorc/${thread.id.slice(0, 8)}`;
  await worktree.add(checkout, { path: folder, branch, startPoint: "main" });
  await writeFile(path.join(folder, `${title}.md`), "work\n");
  await commitAll(folder, title);
  threads.update(mac.db, thread.id, { worktreePath: folder, branch });
  return thread.id;
}

/** The Mac's package for `threadId`, in the brain's inbox, then receive-thread as the Mac asks it. */
async function receive(relocation: string, threadId: string, since: string[] = []) {
  await writeFile(path.join(layout.inbox, `${relocation}.thread`), await mac.relocations.pack(relocation, threadId, { from: "mac", macProject: project.id, since }));
  return ops({ op: "receive-thread", relocation, package: `${relocation}.thread` });
}

it("names the brain's link key, the same each time", async () => {
  const first = (await ops({ op: "identity" })) as { linkKey: string };
  expect(first.linkKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(await ops({ op: "identity" })).toEqual(first);
});

it("takes a thread once however often it is sent, leaving nothing in the inbox", async () => {
  const threadId = await macThread("first");
  expect(await receive("r1", threadId)).toEqual({ received: true });
  expect(await receive("r1", threadId)).toEqual({ received: true });
  expect(existsSync(path.join(layout.inbox, "r1.thread"))).toBe(false);
  expect(threads.get(brain.db, threadId)).toMatchObject({ title: "first" });
  expect(relocations.get(brain.db, "r1")).toMatchObject({ role: "brain", direction: "to-cloud", phase: "arrived" });
  expect(await ops({ op: "drop-arrival", relocation: "r1", threadId })).toEqual({ received: true });
});

it("refuses a receive that comes after the move was called off", async () => {
  const threadId = await macThread("dropped");
  expect(await ops({ op: "drop-arrival", relocation: "r2", threadId })).toEqual({ dropped: true });
  expect(await ops({ op: "drop-arrival", relocation: "r2", threadId })).toEqual({ dropped: true });
  expect(await receive("r2", threadId)).toEqual({ refused: "This move was called off." });
  expect(threads.get(brain.db, threadId)).toBeNull();
});

it("says when its copy lacks the commit a package builds on", async () => {
  await writeFile(path.join(checkout, "later.md"), "after the copy\n");
  await commitAll(checkout, "Later");
  const threadId = await macThread("ahead");
  const main = (await git(checkout, ["rev-parse", "main"])).stdout.trim();
  expect(await receive("r3", threadId, [main])).toEqual({ lacksBase: true });
  expect(threads.get(brain.db, threadId)).toBeNull();
  expect(await receive("r3", threadId)).toEqual({ received: true });
});

it("hands a thread back once, frozen until the Mac took it, then lets its copy go", async () => {
  const threadId = await macThread("going home");
  await receive("r1", threadId);
  const synced = vi.spyOn(brain.cloud, "sync");
  const first = (await ops({ op: "hand-off-thread", relocation: "r4", threadId })) as { file: string; bytes: number; sha256: string };
  expect(first).toMatchObject({ file: "r4.thread", bytes: expect.any(Number), sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
  const written = (await stat(path.join(layout.outbox, first.file))).mtimeMs;
  expect(await ops({ op: "hand-off-thread", relocation: "r4", threadId })).toEqual(first);
  // Asked again, the package already written: the sandbox is not pulled again, nor the file rewritten under a download.
  expect(synced).toHaveBeenCalledTimes(1);
  expect((await stat(path.join(layout.outbox, first.file))).mtimeMs).toBe(written);
  expect(brain.threads.get(threadId)?.moving).toMatchObject({ to: "mac" });
  const send = await brain.handle({ type: "rpc", id: 1, method: "threads.queue", params: { id: threadId, text: "now" } });
  expect(send).toMatchObject({ type: "rpc.error", message: MOVING_WORDS.mac });

  const pkg = await readFile(path.join(layout.outbox, first.file));
  // The Mac's own move up settles as a move does: its copy goes with its journal row.
  relocations.open(mac.db, { id: "r1", threadId, role: "coordinator", direction: "to-cloud", phase: "sending", projectId: project.id });
  await mac.relocations.letGo("r1", threadId, () => relocations.advance(mac.db, "r1", "sending", "done"));
  expect(await mac.relocations.take(pkg, { projectId: (id) => id, place: "here", commit: () => undefined })).toBe("taken");
  const brainFolder = threads.get(brain.db, threadId)!.worktreePath!;
  expect(await ops({ op: "handed-off", relocation: "r4" })).toEqual({ left: true });
  expect(threads.get(brain.db, threadId)).toBeNull();
  expect(existsSync(brainFolder)).toBe(false);
  expect(existsSync(path.join(layout.outbox, first.file))).toBe(false);
  expect(await ops({ op: "handed-off", relocation: "r4" })).toEqual({ left: true });
  expect(relocations.get(brain.db, "r4")).toMatchObject({ phase: "left" });
});

it("unfreezes a thread whose hand-off the Mac called off, and refuses that hand-off after", async () => {
  const threadId = await macThread("staying");
  await receive("r1", threadId);
  await ops({ op: "hand-off-thread", relocation: "r5", threadId });
  expect(await ops({ op: "cancel-hand-off", relocation: "r5", threadId })).toEqual({ stayed: true });
  expect(await ops({ op: "cancel-hand-off", relocation: "r5", threadId })).toEqual({ stayed: true });
  expect(brain.threads.get(threadId)?.moving ?? null).toBeNull();
  expect(await ops({ op: "hand-off-thread", relocation: "r5", threadId })).toEqual({ refused: "This move was called off." });
  expect(await ops({ op: "cancel-hand-off", relocation: "r6", threadId })).toEqual({ stayed: true });
  expect(await ops({ op: "hand-off-thread", relocation: "r6", threadId })).toEqual({ refused: "This move was called off." });
  expect(await ops({ op: "hand-off-thread", relocation: "r7", threadId })).toMatchObject({ file: "r7.thread" });
});

it("never says it let go of a thread whose hand-off was called off", async () => {
  const threadId = await macThread("kept here");
  await receive("r1", threadId);
  await ops({ op: "hand-off-thread", relocation: "r8", threadId });
  await ops({ op: "cancel-hand-off", relocation: "r8", threadId });
  await expect(ops({ op: "handed-off", relocation: "r8" })).rejects.toThrow("called off");
  expect(threads.get(brain.db, threadId)).not.toBeNull();
});
