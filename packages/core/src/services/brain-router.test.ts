import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LedgerWriter, projects, remoteDevices, runs, settings, threads } from "@openorc/db";
import { fromBase64Url, linkPath } from "@openorc/link";
import { nodeCrypto } from "@openorc/link/node";
import { DEFAULT_CLAUDE_ACCOUNT, type CorePush, type Project, type RpcMethod, type RpcParams, type ThreadSummary } from "@openorc/protocol";
import { OpenOrc } from "../openorc.js";
import type { OpenOrcOptions } from "../options.js";
import { until } from "../test-fixtures/fake-claude.js";
import { BrainLink, type BrainEndpoint } from "./brain-link.js";
import { BrainRouter } from "./brain-router.js";
import { CloudBrain } from "./cloud-brain.js";
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
let freshens = 0;

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
  freshen: async () => void freshens++,
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

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "openorc-brain-router-")));
  [windows, wakes, freshens, port, brainKeys] = [[], 0, 0, 0, store()];
  brain = await openBrain();
  brainProject = projects.insert(brain.db, { name: "app", rootPath: path.join(root, "brain-copy"), gitRemote: null, defaultBranch: "main", settings: {} });
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
  threads.update(brain.db, thread.id, { worktreePath: "/vercel/sandbox/openorc-brain/data/worktrees/x" });
  runs.insert(brain.db, { id: "cloud-run", taskId: null, threadId: thread.id, agent: "claude", model: null, mode: "act", permissionMode: "autonomous", claudeAccountId: DEFAULT_CLAUDE_ACCOUNT });
  const ledger = new LedgerWriter(brain.db);
  ledger.push({ type: "message.completed", runId: "cloud-run", ts: 1, messageId: "m1", role: "assistant", text: "Working on it" } as never);
  ledger.close();
  mac = await openMac();
  macProject = await mac.projects.import(root);
  threads.insert(mac.db, { id: "mac-thread", projectId: macProject.id, title: "On the Mac", agent: "claude", model: null, mode: "act", permissionMode: "autonomous" });
});

afterEach(async () => {
  await mac?.close();
  await brain?.close();
  await rm(root, { recursive: true, force: true });
});

const listed = async () => (await window("threads.list", {})) as ThreadSummary[];
/** A list, then the windows told it changed once the brain's part came back; told so for that list, not for its reach. */
async function listedWithTheBrains(): Promise<void> {
  const heard = windows.length;
  await listed();
  await until(() => windows.slice(heard).some((push) => push.type === "invalidate" && push.keys.includes("threads")) && mac!.brainRouting!.router.pages.peek("threads.list", {}) !== null);
}

it("lists both brains' threads in a window, the brain's on this Mac's project and marked as the cloud's", async () => {
  await until(() => mac!.brainRouting!.link.reach === "live");
  await listedWithTheBrains();
  const rows = await listed();
  expect(rows.map((row) => [row.id, row.projectId, row.owner?.brain ?? null, row.owner?.reach ?? null])).toEqual(
    expect.arrayContaining([
      ["mac-thread", macProject.id, null, null],
      ["cloud-thread", macProject.id, "cloud", "live"],
    ]),
  );
  expect(rows.find((row) => row.id === "cloud-thread")?.worktreePath).toBeNull();
  // The brain admitted its Mac by the key derived from its own, with no pairing.
  expect(remoteDevices.list(brain!.db)).toEqual([]);
});

it("forwards a brain thread's calls, and its frames reach this Mac's windows and none of its phones", async () => {
  const published = vi.spyOn(mac!.remote, "publish");
  expect(await window("threads.get", { id: "cloud-thread" })).toMatchObject({ id: "cloud-thread", projectId: macProject.id, owner: { brain: "cloud" }, worktreePath: null });
  const page = (await window("events.page", { runId: "cloud-run" })) as { events: { type: string }[] };
  expect(page.events.map((event) => event.type)).toContain("message.completed");
  // With a run open in a window the Mac's session keeps the brain awake; before, it did not.
  await until(() => brain!.remote.busy);
  brain!.frames.push({ type: "message.delta", runId: "cloud-run", ts: 2, messageId: "m2", text: "more" } as never);
  await until(() => windows.some((push) => push.type === "frame" && push.frame.runId === "cloud-run"));
  expect(published.mock.calls.some(([push]) => push.type === "frame" && push.frame.runId === "cloud-run")).toBe(false);
  await expect(window("threads.fork", { id: "cloud-thread" })).rejects.toThrow("Bring it to this Mac first.");
  await expect(mac!.brainRouting!.link.call("remote.status", {}, { wake: false })).rejects.toThrow("not available to the Mac");
});

it("keeps a quiet session from keeping the brain awake", async () => {
  await until(() => mac!.brainRouting!.link.reach === "live");
  await listedWithTheBrains();
  expect(brain!.remote.busy).toBe(false);
});

it("lists the brain's threads from its last answer, at once, while it sleeps, across a restart of the Mac", async () => {
  await until(() => mac!.brainRouting!.link.reach === "live");
  await listedWithTheBrains();
  await brain!.close();
  brain = null;
  await until(() => mac!.brainRouting!.link.reach !== "live");
  await mac!.close();
  mac = await openMac();
  const started = performance.now();
  const rows = await listed();
  expect(performance.now() - started).toBeLessThan(50);
  expect(rows.find((row) => row.id === "cloud-thread")?.owner).toMatchObject({ brain: "cloud" });
  expect(rows.find((row) => row.id === "cloud-thread")?.owner?.reach).not.toBe("live");
  // Opening it shows the brain's last answer at once, without waking it; reading its runs is the window's own intent.
  expect(await window("threads.get", { id: "cloud-thread" })).toMatchObject({ id: "cloud-thread", owner: { brain: "cloud" } });
  expect(wakes).toBe(0);
  await expect(window("runs.listForThread", { threadId: "cloud-thread" })).rejects.toThrow();
  expect(wakes).toBe(1);
});

it("has the brain's project copies follow this Mac while both are awake: as it answers, now and then, and before sleep", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  try {
    await mac!.close();
    freshens = 0;
    mac = await openMac();
    await until(() => mac!.brainRouting!.link.reach === "live" && freshens === 1);
    vi.advanceTimersByTime(2 * 60_000);
    expect(freshens).toBe(2);
    await mac!.brainRouting!.freshen();
    expect(freshens).toBe(3);
    await brain!.close();
    brain = null;
    await until(() => mac!.brainRouting!.link.reach !== "live");
    vi.advanceTimersByTime(2 * 60_000);
    await mac!.brainRouting!.freshen();
    expect(freshens).toBe(3);
  } finally {
    vi.useRealTimers();
  }
});

it("routes nothing and reads nothing for the brain on a Mac without one", async () => {
  await mac!.close();
  const routed = vi.spyOn(BrainRouter.prototype, "handle");
  const read = vi.spyOn(settings, "get");
  const dialed = vi.spyOn(BrainLink.prototype, "start");
  const machine = vi.spyOn(CloudBrain.prototype, "withMachine");
  mac = await OpenOrc.create({ dataDir: path.join(root, "plain"), transport: { push: () => {} } });
  await window("threads.list", {});
  await window("threads.get", { id: "cloud-thread" });
  expect(routed).not.toHaveBeenCalled();
  expect(read.mock.calls.some(([, key]) => key === "brain.pages")).toBe(false);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(dialed).not.toHaveBeenCalled();
  expect(machine).not.toHaveBeenCalled();
});
