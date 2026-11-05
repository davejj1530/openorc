import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { projects, threads } from "@openorc/db";
import { commitAll, git, worktree } from "@openorc/git";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fromBase64Url, linkPath } from "@openorc/link";
import { nodeCrypto } from "@openorc/link/node";
import { type CorePush, type MirrorSnapshot, type Project, type RpcMethod, type RpcParams } from "@openorc/protocol";
import { OpenOrc } from "../openorc.js";
import type { OpenOrcOptions } from "../options.js";
import { until } from "../test-fixtures/fake-claude.js";
import type { BrainEndpoint } from "./brain-link.js";
import { closeMirror, mirrorFolder } from "./brain-mirrors.js";
import { ownerLinkKeys } from "./owner-link.js";

let root: string;
let brain: OpenOrc | null;
let mac: OpenOrc | null;
let brainProject: Project;
let macProject: Project;
let port = 0;
let brainKey: Uint8Array;
const brainSecret = new Uint8Array(32).fill(7);
const owner = ownerLinkKeys(brainSecret as never);
let windows: CorePush[] = [];
let wakes = 0;

const store = () => {
  let saved: string | null = null;
  return { load: async () => saved, save: async (value: string) => void (saved = value) };
};

async function openBrain(): Promise<OpenOrc> {
  const core = await OpenOrc.create({
    dataDir: path.join(root, "brain"),
    ephemeral: true,
    transport: { push: () => {} },
    remoteSecrets: brainKeys,
    remoteNetwork: { port, publicAddress: "127.0.0.1", owner: owner.publicKey, machine: { name: () => "Cloud", lanHosts: () => [], tailnetHosts: async () => [] } },
  });
  await core.remote.attach((request, origin) => core.handle(request, origin));
  const status = await core.remote.configure(true);
  if (status.listener.state !== "on") throw new Error("the brain's listener did not start");
  port = status.listener.port;
  brainKey = fromBase64Url(await core.remote.linkKey());
  return core;
}
let brainKeys = store();

const endpoint: BrainEndpoint = {
  ready: async () => true,
  locate: async () => ({ url: `ws://127.0.0.1:${port}${linkPath("public", brainKey, nodeCrypto)}`, brainKey, ownerKeys: owner }),
  wake: async () => void wakes++,
  projects: async () => ({
    toCloud: (id) => (id === macProject.id ? brainProject.id : null),
    toMac: (id) => (id === brainProject.id ? macProject.id : null),
  }),
};

async function openMac(options: Partial<OpenOrcOptions> = {}): Promise<OpenOrc> {
  return OpenOrc.create({ dataDir: path.join(root, "mac"), transport: { push: (message) => void windows.push(message) }, brainEndpoint: endpoint, ...options });
}

/** A window's call to the Mac: no origin, as the desktop's ports send them. */
async function window<M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<unknown> {
  const reply = await mac!.handle({ type: "rpc", id: 1, method, params });
  if (reply.type === "rpc.error") throw new Error(reply.message);
  return reply.result;
}

let brainFolder = "";

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "openorc-brain-mirrors-")));
  [windows, wakes, port, brainKeys] = [[], 0, 0, store()];
  const checkout = path.join(root, "app");
  await git(root, ["init", "-q", "-b", "main", checkout]);
  writeFileSync(path.join(checkout, "README.md"), "# Mirror\n");
  // History both sides share, too large to send again.
  writeFileSync(path.join(checkout, "assets.bin"), randomBytes(2 * 1024 * 1024));
  await commitAll(checkout, "Baseline");
  brain = await openBrain();
  const copy = path.join(root, "brain-copy");
  await git(root, ["clone", "-q", checkout, copy]);
  brainProject = projects.insert(brain.db, { name: "app", rootPath: copy, gitRemote: null, defaultBranch: "main", settings: {} });
  const thread = threads.insert(brain.db, {
    id: "cloud-thread",
    projectId: brainProject.id,
    title: "In the cloud",
    agent: "claude",
    model: null,
    mode: "act",
    permissionMode: "autonomous",
    workspaceMode: "worktree",
  });
  brainFolder = path.join(root, "brain-worktree");
  await worktree.add(copy, { path: brainFolder, branch: "openorc/cloud", startPoint: "main" });
  writeFileSync(path.join(brainFolder, "feature.md"), "committed in the cloud\n");
  await commitAll(brainFolder, "Cloud work");
  writeFileSync(path.join(brainFolder, "draft.md"), "not committed yet\n");
  threads.update(brain.db, thread.id, { worktreePath: brainFolder, branch: "openorc/cloud" });
  mac = await openMac();
  macProject = await mac.projects.import(checkout);
});

afterEach(async () => {
  await mac?.close();
  await brain?.close();
  await rm(root, { recursive: true, force: true });
});

it("opens a cloud thread's code on this Mac, read-only, and keeps it current one way", async () => {
  await window("cloud.openOnMac", { threadId: "cloud-thread" });
  const opened = (await window("threads.get", { id: "cloud-thread" })) as { worktreePath: string; owner: { mirror?: boolean } };
  expect(opened.owner.mirror).toBe(true);
  const copy = opened.worktreePath;
  expect(readFileSync(path.join(copy, "feature.md"), "utf8")).toBe("committed in the cloud\n");
  expect(readFileSync(path.join(copy, "draft.md"), "utf8")).toBe("not committed yet\n");
  expect(await window("files.read", { scope: { kind: "thread", id: "cloud-thread" }, path: "draft.md" })).toMatchObject({ readOnly: expect.stringContaining("Bring it to this Mac") });
  // An edit made in the copy here is kept aside, and never reaches the cloud.
  writeFileSync(path.join(copy, "draft.md"), "edited on the Mac\n");
  writeFileSync(path.join(brainFolder, "agent.md"), "written by the agent\n");
  brain!.remote.publish({ type: "invalidate", keys: ["threaddiff:cloud-thread"] });
  await until(() => existsSync(path.join(copy, "agent.md")));
  expect(readFileSync(path.join(copy, "draft.md"), "utf8")).toBe("not committed yet\n");
  expect(readFileSync(path.join(brainFolder, "draft.md"), "utf8")).toBe("not committed yet\n");
  const kept = (await git(path.join(root, "app"), ["for-each-ref", "--format=%(objectname)", "refs/openorc/mirror/cloud-thread/kept/"])).stdout.trim();
  expect((await git(path.join(root, "app"), ["show", `${kept}:draft.md`])).stdout).toBe("edited on the Mac\n");
  await window("cloud.closeOnMac", { threadId: "cloud-thread" });
  expect(existsSync(copy)).toBe(false);
  expect(((await window("threads.get", { id: "cloud-thread" })) as { worktreePath: string | null }).worktreePath).toBeNull();
});

it("keeps edits made in the copy aside when it closes, and says where", async () => {
  await window("cloud.openOnMac", { threadId: "cloud-thread" });
  const copy = mirrorFolder(mac!.db, "cloud-thread")!.path;
  writeFileSync(path.join(copy, "draft.md"), "edited on the Mac before closing\n");
  await window("cloud.closeOnMac", { threadId: "cloud-thread" });
  expect(existsSync(copy)).toBe(false);
  const keptRefs = async () => (await git(path.join(root, "app"), ["for-each-ref", "--format=%(refname) %(objectname)", "refs/openorc/mirror/cloud-thread/kept/"])).stdout.split("\n").filter(Boolean);
  const refs = await keptRefs();
  expect(refs).toEqual([expect.stringMatching(/^refs\/openorc\/mirror\/cloud-thread\/kept\/\d+ [0-9a-f]{40}$/)]);
  const [ref, kept] = refs[0]!.split(" ");
  expect((await git(path.join(root, "app"), ["show", `${kept}:draft.md`])).stdout).toBe("edited on the Mac before closing\n");
  expect(windows).toContainEqual(expect.objectContaining({ type: "log", message: expect.stringContaining(ref!) }));
  // A copy closed untouched keeps nothing.
  await window("cloud.openOnMac", { threadId: "cloud-thread" });
  await window("cloud.closeOnMac", { threadId: "cloud-thread" });
  expect(await keptRefs()).toEqual(refs);
});

it("brings only what this Mac lacks the first time a cloud thread opens here", async () => {
  const asked = vi.spyOn(mac!.brainRouting!.link, "call");
  await window("cloud.openOnMac", { threadId: "cloud-thread" });
  const at = asked.mock.calls.findIndex(([method]) => method === "threads.snapshot");
  const snapshot = (await asked.mock.results[at]!.value) as MirrorSnapshot;
  expect(Buffer.from(snapshot.bundle!, "base64").length).toBeLessThan(256 * 1024);
});

it("leaves a copy closed when it closes while a refresh waits on the brain", async () => {
  await window("cloud.openOnMac", { threadId: "cloud-thread" });
  const copy = mirrorFolder(mac!.db, "cloud-thread")!.path;
  const link = mac!.brainRouting!.link;
  const call = link.call.bind(link);
  let answer: () => void = () => {};
  vi.spyOn(link, "call").mockImplementation(async (method, params, options) => {
    if (method === "threads.snapshot") await new Promise<void>((resolve) => (answer = resolve));
    return call(method, params, options);
  });
  writeFileSync(path.join(brainFolder, "agent.md"), "written by the agent\n");
  const pulled = mac!.brainRouting!.mirrors.pull("cloud-thread");
  await until(() => vi.mocked(link.call).mock.calls.some(([method]) => method === "threads.snapshot"));
  await closeMirror(mac!.db, "cloud-thread", { info: () => {} });
  answer();
  await pulled;
  expect(mirrorFolder(mac!.db, "cloud-thread")).toBeNull();
  expect(existsSync(copy)).toBe(false);
});
