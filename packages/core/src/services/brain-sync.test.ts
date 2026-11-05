import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LocalSandboxProvider } from "@openorc/cloud";
import { memories, settings, tasks } from "@openorc/db";
import { commitAll, git } from "@openorc/git";
import { fromBase64Url, linkPath } from "@openorc/link";
import { nodeCrypto } from "@openorc/link/node";
import type { CorePush, MacBacklog, Project, RpcMethod, RpcParams, Task, TaskBoard } from "@openorc/protocol";
import { OpenOrc } from "../openorc.js";
import { until } from "../test-fixtures/fake-claude.js";
import type { BrainEndpoint } from "./brain-link.js";
import { ownerLinkKeys } from "./owner-link.js";
import { inheritedProbe } from "./shell-environment.js";

let root: string;
let brain: OpenOrc;
let mac: OpenOrc;
let macProject: Project;
let brainProject: Project;
let brainKey: Uint8Array;
let port = 0;
/** What the brain embedded of what it took. */
let embedded: string[] = [];
let windows: CorePush[] = [];
const owner = ownerLinkKeys(new Uint8Array(32).fill(7) as never);
const noEmbeddings = { ready: async () => false, embed: async () => null, embedQuery: async () => null };

async function openBrain(): Promise<OpenOrc> {
  const core = await OpenOrc.create({
    dataDir: path.join(root, "brain"),
    ephemeral: true,
    transport: { push: () => {} },
    shellProbe: inheritedProbe(process.env),
    cloudOnly: true,
    deviceSystem: null,
    embedder: {
      ...noEmbeddings,
      embed: async (texts) => {
        embedded.push(...texts);
        return null;
      },
    },
    cloudSandboxes: new LocalSandboxProvider(path.join(root, "sandboxes"), () => process.env, 1500),
    remoteSecrets: { load: async () => null, save: async () => {} },
    remoteNetwork: { port: 0, publicAddress: "127.0.0.1", owner: owner.publicKey, machine: { name: () => "Cloud", lanHosts: () => [], tailnetHosts: async () => [] } },
  });
  await core.remote.attach((request, origin) => core.handle(request, origin));
  const status = await core.remote.configure(true);
  if (status.listener.state !== "on") throw new Error("the brain's listener did not start");
  port = status.listener.port;
  brainKey = fromBase64Url(await core.remote.linkKey());
  return core;
}

const endpoint: BrainEndpoint = {
  ready: async () => true,
  locate: async () => ({ url: `ws://127.0.0.1:${port}${linkPath("public", brainKey, nodeCrypto)}`, brainKey, ownerKeys: owner }),
  wake: async () => undefined,
  projects: async () => ({
    toCloud: (id) => (id === macProject.id ? brainProject.id : null),
    toMac: (id) => (id === brainProject.id ? macProject.id : null),
    pairs: [{ mac: macProject.id, cloud: brainProject.id }],
  }),
};

async function on<M extends RpcMethod>(core: OpenOrc, method: M, params: RpcParams<M>): Promise<unknown> {
  const reply = await core.handle({ type: "rpc", id: 1, method, params });
  if (reply.type === "rpc.error") throw new Error(reply.message);
  return reply.result;
}

const titles = (core: OpenOrc, project: Project) =>
  memories
    .list(core.db, { projectId: project.id })
    .map((memory) => memory.title)
    .sort();

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "openorc-brain-sync-")));
  embedded = [];
  const checkout = path.join(root, "app");
  await mkdir(checkout);
  await git(checkout, ["init", "-q", "-b", "main"]);
  await writeFile(path.join(checkout, "README.md"), "# Synced\n");
  await commitAll(checkout, "Baseline");
  brain = await openBrain();
  windows = [];
  mac = await OpenOrc.create({
    dataDir: path.join(root, "mac"),
    transport: { push: (message) => void windows.push(message) },
    shellProbe: inheritedProbe(process.env),
    embedder: noEmbeddings,
    brainEndpoint: endpoint,
  });
  settings.set(mac.db, "extraction.provider", "off");
  macProject = await mac.projects.import(checkout);
  const copy = path.join(root, "brain", "projects", macProject.id, "app");
  await git(root, ["clone", "-q", checkout, copy]);
  brainProject = await brain.projects.import(copy);
  await until(() => mac.brainRouting!.link.reach === "live");
});

afterEach(async () => {
  await mac.close();
  await brain.close();
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

it("merges a project's memory both ways while both are awake, follows a removal, and hears the brain's own changes", async () => {
  await on(mac, "memory.settings.set", { enabled: true });
  const mine = (await on(mac, "memory.record", { projectId: macProject.id, type: "convention", title: "Use pnpm", body: "Never npm." })) as { id: string };
  memories.upsert(brain.db, { projectId: brainProject.id, type: "convention", title: "Tests use vitest", body: "With maxWorkers 4.", source: "agent" });
  await mac.brainRouting!.freshen();
  expect(titles(brain, brainProject)).toEqual(["Tests use vitest", "Use pnpm"]);
  expect(titles(mac, macProject)).toEqual(["Tests use vitest", "Use pnpm"]);
  expect(memories.get(brain.db, mine.id)).toMatchObject({ projectId: brainProject.id, source: "user", body: "Never npm." });
  expect(settings.get(brain.db, "memory.enabled")).toBe("true");
  await until(() => embedded.includes("Use pnpm\nNever npm."));

  await on(mac, "memory.remove", { id: mine.id, projectId: macProject.id });
  await mac.brainRouting!.freshen();
  expect(memories.get(brain.db, mine.id)).toBeNull();

  // Recorded on the brain while both are awake: its push says memory changed, and the next exchange brings it.
  await on(brain, "memory.record", { projectId: brainProject.id, type: "lesson", title: "Ports", body: "Keep five." });
  await exchangedUntil(() => titles(mac, macProject).includes("Ports"));
  expect(titles(mac, macProject)).toEqual(["Ports", "Tests use vitest"]);
});

/** Exchanges as the 2-minute look would, until `done`: the brain's push that its memory changed arrives on its own time. */
async function exchangedUntil(done: () => boolean): Promise<void> {
  for (const deadline = Date.now() + 5000; !done() && Date.now() < deadline;) {
    await mac.brainRouting!.freshen();
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

it("sends at once a fact the brain lacks that beats the brain's on its topic, so both keep the same one", async () => {
  await on(mac, "memory.settings.set", { enabled: true });
  await mac.brainRouting!.freshen();
  await on(brain, "memory.record", { projectId: brainProject.id, type: "convention", title: "Two spaces", body: "Indent.", topicKey: "indent" });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const mine = (await on(mac, "memory.record", { projectId: macProject.id, type: "convention", title: "Tabs", body: "Indent.", topicKey: "indent" })) as { id: string };
  // As if the brain had lost what it took: this Mac's cursor is past its own fact.
  const cursors = JSON.parse(settings.get(mac.db, "brain.memory")!) as Record<string, { sent: number }>;
  cursors[macProject.id]!.sent = Date.now() + 60_000;
  settings.set(mac.db, "brain.memory", JSON.stringify(cursors));
  await exchangedUntil(() => memories.activeOnTopic(brain.db, brainProject.id, "indent")?.id === mine.id);
  expect(memories.activeOnTopic(brain.db, brainProject.id, "indent")?.id).toBe(mine.id);
  expect(memories.activeOnTopic(mac.db, macProject.id, "indent")?.id).toBe(mine.id);
});

it("sends no memory while the Mac's is off, and turns the brain's off with it", async () => {
  await on(mac, "memory.settings.set", { enabled: true });
  await mac.brainRouting!.freshen();
  expect(settings.get(brain.db, "memory.enabled")).toBe("true");
  await on(mac, "memory.settings.set", { enabled: false });
  memories.upsert(mac.db, { projectId: macProject.id, type: "convention", title: "Private", body: "Stays here.", source: "user" });
  await mac.brainRouting!.freshen();
  expect(titles(brain, brainProject)).toEqual([]);
  expect(settings.get(brain.db, "memory.enabled")).toBe("false");
});

it("has the brain distil with the Mac's provider and models, told again whenever they change", async () => {
  await on(mac, "memory.settings.set", { enabled: true, provider: "codex", model: "gpt-5.1-codex-mini" });
  await mac.brainRouting!.freshen();
  expect(settings.get(brain.db, "extraction.provider")).toBe("codex");
  expect(settings.get(brain.db, "extraction.model.codex")).toBe("gpt-5.1-codex-mini");

  // Only the choice changed, so no memory goes; the brain still hears it.
  await on(mac, "memory.settings.set", { provider: "claude", model: "claude-sonnet-4-5" });
  await mac.brainRouting!.freshen();
  expect(settings.get(brain.db, "extraction.provider")).toBe("claude");
  expect(settings.get(brain.db, "extraction.model.claude")).toBe("claude-sonnet-4-5");
  await on(mac, "memory.settings.set", { model: null });
  await mac.brainRouting!.freshen();
  expect(settings.get(brain.db, "extraction.model.claude")).toBeNull();
  expect(settings.get(brain.db, "extraction.model.codex")).toBe("gpt-5.1-codex-mini");

  // Until the sealed handover brings the Mac's Anthropic API key, the brain distils nothing rather than with its own Claude.
  await on(mac, "memory.settings.set", { provider: "apikey" });
  await mac.brainRouting!.freshen();
  expect(settings.get(brain.db, "extraction.provider")).toBe("apikey");
  expect(await brain.memory.extractor("claude")).toBeNull();
});

it("has the brain name conversations as the Mac's text generation choice says, told again when it changes", async () => {
  await on(mac, "textGeneration.settings.set", { provider: "codex", model: "gpt-5.1-codex-mini" });
  await mac.brainRouting!.freshen();
  expect(brain.textGeneration.choice()).toEqual({ provider: "codex", models: { codex: "gpt-5.1-codex-mini" } });
  await on(mac, "textGeneration.settings.set", { provider: "off" });
  await mac.brainRouting!.freshen();
  expect(brain.textGeneration.choice()).toEqual({ provider: "off", models: { codex: "gpt-5.1-codex-mini" } });

  // Sent only when it changed: the brain's own word stands until the Mac's moves again.
  brain.textGeneration.follow({ provider: "auto", models: {} });
  await mac.brainRouting!.freshen();
  expect(brain.textGeneration.choice()).toEqual({ provider: "auto", models: {} });
  await on(mac, "textGeneration.settings.set", { provider: "claude" });
  await mac.brainRouting!.freshen();
  expect(brain.textGeneration.choice()).toEqual({ provider: "claude", models: { codex: "gpt-5.1-codex-mini" } });
  await expect(on(mac, "brain.textGeneration", { provider: "auto", models: {} })).rejects.toThrow("Only a cloud brain");
});

it("keeps the Mac's open tasks on the brain, on the brain's projects, apart from its own", async () => {
  const task = (await on(mac, "tasks.create", { projectId: macProject.id, title: "Write the docs" })) as { id: string };
  await on(mac, "tasks.create", { projectId: macProject.id, title: "Shipped" }).then((done) => on(mac, "tasks.update", { id: (done as { id: string }).id, patch: { status: "done" } }));
  await mac.brainRouting!.freshen();
  const kept = JSON.parse(settings.get(brain.db, "mac.backlog")!) as MacBacklog;
  expect(kept.tasks.map((each) => [each.id, each.title, each.projectId, each.worktreePath])).toEqual([[task.id, "Write the docs", brainProject.id, null]]);
  expect(tasks.list(brain.db)).toEqual([]);
  // What a phone's task list reads: the brain's own and its copy of the Mac's, with nothing about folders; a Mac has no copy.
  const board = await brain.remote.device("phone-1", "tasks.board", {});
  expect(board).toEqual({ tasks: [], mac: { at: kept.at, tasks: [expect.objectContaining({ id: task.id, title: "Write the docs", projectId: brainProject.id, status: "backlog" })] } });
  expect(Object.keys((board as TaskBoard).mac!.tasks[0]!)).not.toContain("worktreePath");
  expect(await mac.remote.device("phone-1", "tasks.board", {})).toEqual({ tasks: [expect.objectContaining({ id: task.id, projectId: macProject.id })], mac: null });
});

it("lists a task the brain holds in a Mac window, marked as the cloud's, and changes it on the brain", async () => {
  const made = (await on(brain, "tasks.create", { projectId: brainProject.id, title: "Cloud work" })) as Task;
  const heard = windows.length;
  await on(mac, "tasks.list", {});
  await until(() => windows.slice(heard).some((push) => push.type === "invalidate" && push.keys.includes("tasks")));
  const listed = (await on(mac, "tasks.list", {})) as Task[];
  expect(listed.map((task) => [task.id, task.projectId, task.owner?.brain])).toEqual([[made.id, macProject.id, "cloud"]]);
  await on(mac, "tasks.update", { id: made.id, patch: { status: "done" } });
  expect(tasks.get(brain.db, made.id)?.status).toBe("done");
  expect(tasks.get(mac.db, made.id)).toBeNull();
});
