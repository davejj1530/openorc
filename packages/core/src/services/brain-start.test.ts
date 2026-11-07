import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LocalSandboxProvider } from "@openorc/cloud";
import { settings, threads } from "@openorc/db";
import { commitAll, git } from "@openorc/git";
import { fromBase64Url, linkPath } from "@openorc/link";
import { nodeCrypto } from "@openorc/link/node";
import { DEFAULT_CLAUDE_ACCOUNT, type CorePush, type Project, type RpcMethod, type RpcParams, type ThreadSummary } from "@openorc/protocol";
import { OpenOrc } from "../openorc.js";
import { FAKE_CLAUDE, turnsIn, until } from "../test-fixtures/fake-claude.js";
import type { BrainEndpoint } from "./brain-link.js";
import { ownerLinkKeys } from "./owner-link.js";
import { inheritedProbe } from "./shell-environment.js";

let root: string;
let log: string;
let env: NodeJS.ProcessEnv;
let brain: OpenOrc;
let mac: OpenOrc;
let macProject: Project;
let brainProject: Project;
let brainKey: Uint8Array;
let port = 0;
let windows: CorePush[] = [];
const owner = ownerLinkKeys(new Uint8Array(32).fill(9) as never);

function store(initial: string | null = null) {
  let saved = initial;
  return { load: async () => saved, save: async (value: string) => void (saved = value) };
}

async function quiet(core: OpenOrc): Promise<OpenOrc> {
  settings.set(core.db, "extraction.provider", "off");
  vi.spyOn(core.textGeneration, "title").mockResolvedValue(null);
  vi.spyOn(core.runs, "models").mockResolvedValue([{ id: "fixture", label: "Fixture", agent: "claude", isDefault: true, efforts: ["high"], defaultEffort: "high", fastMode: { supported: false } }]);
  return core;
}

/** The brain: a cloud-only core with its thread sandboxes in folders here, its phone listener open to its Mac's key. */
async function openBrain(): Promise<OpenOrc> {
  const sandboxEnv = { ...env, CLAUDE_CONFIG_DIR: undefined, HOME: path.join(root, "sandbox-home") };
  const core = await OpenOrc.create({
    dataDir: path.join(root, "brain"),
    ephemeral: true,
    transport: { push: () => {} },
    shellProbe: inheritedProbe(env),
    cloudOnly: true,
    deviceSystem: null,
    claudeCloudSecrets: store(JSON.stringify({ [DEFAULT_CLAUDE_ACCOUNT]: { token: "sk-ant-oat01-fixture", createdAt: 1 } })),
    cloudSandboxes: new LocalSandboxProvider(path.join(root, "sandboxes"), () => sandboxEnv, 1500),
    remoteSecrets: store(),
    remoteNetwork: { port: 0, publicAddress: "127.0.0.1", owner: owner.publicKey, machine: { name: () => "Cloud", lanHosts: () => [], tailnetHosts: async () => [] } },
  });
  await core.remote.attach((request, origin) => core.handle(request, origin));
  const status = await core.remote.configure(true);
  if (status.listener.state !== "on") throw new Error("the brain's listener did not start");
  port = status.listener.port;
  brainKey = fromBase64Url(await core.remote.linkKey());
  return quiet(core);
}

/** The wake a window's cloud start waits for; at once unless a test holds it. */
let waking: Promise<void> = Promise.resolve();
const endpoint: BrainEndpoint = {
  ready: async () => true,
  locate: async () => ({ url: `ws://127.0.0.1:${port}${linkPath("public", brainKey, nodeCrypto)}`, brainKey, ownerKeys: owner }),
  wake: () => waking,
  projects: async () => ({
    toCloud: (id) => (id === macProject.id ? brainProject.id : null),
    toMac: (id) => (id === brainProject.id ? macProject.id : null),
  }),
};

async function window<M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<unknown> {
  const reply = await mac.handle({ type: "rpc", id: 1, method, params });
  if (reply.type === "rpc.error") throw new Error(reply.message);
  return reply.result;
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "openorc-brain-start-")));
  windows = [];
  waking = Promise.resolve();
  const checkout = path.join(root, "app");
  await mkdir(checkout);
  await git(checkout, ["init", "-q", "-b", "main"]);
  await writeFile(path.join(checkout, "README.md"), "# Started in the cloud\n");
  await commitAll(checkout, "Baseline");
  const bin = path.join(root, "bin");
  await mkdir(bin);
  await writeFile(path.join(bin, "claude"), FAKE_CLAUDE);
  await chmod(path.join(bin, "claude"), 0o755);
  log = path.join(root, "turns.jsonl");
  env = { ...process.env, PATH: `${bin}:${process.env["PATH"] ?? ""}`, CLAUDE_CONFIG_DIR: path.join(root, "claude-config"), FAKE_LOG: log, OPENORC_CLAUDE_BIN: path.join(bin, "claude") };
  vi.stubEnv("FAKE_LOG", log);
  brain = await openBrain();
  mac = await quiet(await OpenOrc.create({ dataDir: path.join(root, "mac"), transport: { push: (message) => void windows.push(message) }, shellProbe: inheritedProbe(env), brainEndpoint: endpoint }));
  macProject = await mac.projects.import(checkout);
  const copy = path.join(root, "brain", "projects", macProject.id, "app");
  await git(root, ["clone", "-q", checkout, copy]);
  brainProject = await brain.projects.import(copy);
});

afterEach(async () => {
  await mac.close();
  await brain.close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  // The brain may still be seeding the thread's sandbox as the folder goes.
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

it("starts a new cloud thread from a Mac window on the brain, open at once, its first message and one sent meanwhile run there", async () => {
  await until(() => mac.brainRouting!.link.reach === "live");
  const heard = windows.length;
  await window("threads.list", {});
  await until(() => windows.slice(heard).some((push) => push.type === "invalidate" && push.keys.includes("threads")));

  let woken!: () => void;
  waking = new Promise((resolve) => (woken = resolve));
  const { thread } = (await window("threads.start", {
    projectId: macProject.id,
    cloud: true,
    workspaceMode: "worktree",
    agent: "claude",
    model: "fixture",
    mode: "act",
    permissionMode: "autonomous",
    prompt: "Start in the cloud",
  })) as { thread: ThreadSummary };

  expect(thread).toMatchObject({ projectId: macProject.id, worktreePath: null, owner: { brain: "cloud" }, cloud: { state: "preparing", brain: "waking" } });
  expect(threads.get(mac.db, thread.id)).toBeNull();
  expect(threads.get(brain.db, thread.id)).toBeNull();
  expect(((await window("threads.list", {})) as ThreadSummary[]).find((row) => row.id === thread.id)).toMatchObject({ cloud: { brain: "waking" } });
  await window("threads.queue", { id: thread.id, text: "Then say more" });
  woken();

  await until(() => threads.get(brain.db, thread.id) !== null);
  expect(threads.get(brain.db, thread.id)).toMatchObject({ id: thread.id, projectId: brainProject.id });
  // The brain's own row, under the same id, in place of the one shown while it started.
  await vi.waitFor(async () => {
    const row = ((await window("threads.list", {})) as ThreadSummary[]).find((each) => each.id === thread.id);
    expect(row).toMatchObject({ projectId: macProject.id, owner: { brain: "cloud", reach: "live" } });
    expect(row?.cloud?.brain).toBeUndefined();
    expect(mac.brainRouting!.router.starts.rows(() => true)).toEqual([]);
  });
  await until(() => turnsIn(log).some((turn) => turn.prompt.includes("Start in the cloud")), 30_000);
  await until(() => turnsIn(log).some((turn) => turn.prompt.includes("Then say more")), 30_000);
  expect(await window("threads.get", { id: thread.id })).toMatchObject({ id: thread.id, projectId: macProject.id, owner: { brain: "cloud" } });

  // An image the window attached on this Mac is stored on the brain before the message naming it.
  const image = path.join(root, "mac", "attachments", "shot.png");
  await mkdir(path.dirname(image), { recursive: true });
  await writeFile(image, Buffer.from(PNG, "base64"));
  await until(() => brain.runs.threadActivity(thread.id) === "idle");
  await window("threads.queue", { id: thread.id, text: "See this", attachments: [image] });
  const stored = path.join(root, "brain", "attachments");
  const queued = () => brain.db.stmt("SELECT text, attachments FROM thread_queue WHERE thread_id = ?").all(thread.id) as { text: string; attachments: string }[];
  await until(() => queued().some((entry) => entry.text === "See this"));
  const sent = JSON.parse(queued().find((entry) => entry.text === "See this")!.attachments) as string[];
  expect(sent.map((file) => path.dirname(file))).toEqual([stored]);

  // Any other file the window attached goes up the same way, and the window keeps the thread's draft there as here.
  const report = path.join(root, "mac", "attachments", "0b9f3c3e-5d2a-4f1e-9c47-2a6f0d8e1b55-report.csv");
  await writeFile(report, "a,b\n1,2\n");
  await window("threads.queue", { id: thread.id, text: "Read this", attachments: [report] });
  await until(() => queued().some((entry) => entry.text === "Read this"));
  const [file] = JSON.parse(queued().find((entry) => entry.text === "Read this")!.attachments) as string[];
  expect(path.dirname(file!)).toBe(stored);
  expect(path.basename(file!)).toMatch(/^[a-f0-9-]{36}-report\.csv$/);
  expect(await readFile(file!, "utf8")).toBe("a,b\n1,2\n");
  await window("threads.update", { id: thread.id, patch: { draft: "Half a thought" } });
  expect(threads.get(brain.db, thread.id)).toMatchObject({ draft: "Half a thought" });
});

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
