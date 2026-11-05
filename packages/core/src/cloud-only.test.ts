import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { ClaudeAdapter } from "@openorc/agents";
import type { SandboxProvider } from "@openorc/cloud";
import { runs, tasks, threadQueue, threads } from "@openorc/db";
import { commitAll, git } from "@openorc/git";
import { DEFAULT_CLAUDE_ACCOUNT, WORKSPACE_ID, harnessInfo, harnessLoggedIn, type Project } from "@openorc/protocol";
import { nodeSystem } from "./devices/system.js";
import { OpenOrc } from "./openorc.js";
import type { OpenOrcOptions } from "./options.js";
import { rpcClient } from "./rpc-test-client.js";
import { LOCAL_LAUNCH_REFUSED } from "./services/cloud-workspaces.js";

const TOKEN = "sk-ant-oat01-fixture-cloud-token-for-tests";

/** Stands in for Claude Code's version and sign-in checks: signed in only with the fixture's cloud token. */
const FAKE_CLAUDE = `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === "--version") console.log("2.1.316 (Claude Code)");
else if (args.includes("auth") && args.includes("status")) console.log(JSON.stringify({ loggedIn: process.env.CLAUDE_CODE_OAUTH_TOKEN === ${JSON.stringify(TOKEN)} }));
else process.exit(1);
`;

let root: string;
let checkout: string;
let claude: string;
let opened: string[];
let core: OpenOrc;
let project: Project;
const rpc = rpcClient(() => core);

/** Vercel as far as the core can tell: it records the sandbox asked for, then fails to open it. */
const fakeVercel: SandboxProvider = {
  id: "vercel",
  open: async (name) => {
    opened.push(name);
    throw new Error("The fake Vercel is offline.");
  },
  remove: async () => undefined,
  list: async () => [],
};

function tokenStore(): NonNullable<OpenOrcOptions["claudeCloudSecrets"]> {
  let saved: string | null = JSON.stringify({ [DEFAULT_CLAUDE_ACCOUNT]: { token: TOKEN, createdAt: 1 } });
  return { load: async () => saved, save: async (value) => void (saved = value) };
}

async function open(options: Partial<OpenOrcOptions>): Promise<OpenOrc> {
  core = await OpenOrc.create({
    dataDir: path.join(root, `data-${Math.random().toString(36).slice(2)}`),
    ephemeral: true,
    transport: { push() {} },
    shellProbe: async () => ({ path: process.env["PATH"] ?? "", binaries: { claude, codex: null, opencode: null } }),
    claudeCloudSecrets: tokenStore(),
    cloudSandboxes: fakeVercel,
    cloudOffered: true,
    ...options,
  });
  project = await core.projects.import(checkout);
  return core;
}

const cloudOnly = { cloudOnly: true, deviceSystem: null } satisfies Partial<OpenOrcOptions>;

async function tools(): Promise<string[]> {
  const thread = threads.insert(core.db, { projectId: project.id, title: "Tools", agent: "codex", model: null, mode: "act", permissionMode: "trusted" });
  runs.insert(core.db, { id: "tools-run", threadId: thread.id, taskId: null, agent: "codex", model: null, mode: "act", permissionMode: "trusted" });
  vi.spyOn(core.runs, "isLive").mockImplementation((id) => id === "tools-run");
  const mcp = await core.mcpServer();
  const response = await fetch(mcp.urlForRun("tools-run"), {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  const body = await response.text();
  const data = body.split("\n").find((line) => line.startsWith("data: "));
  return (JSON.parse(data ? data.slice(6) : body) as { result: { tools: { name: string }[] } }).result.tools.map((tool) => tool.name);
}

const start = { agent: "claude", model: undefined, effort: undefined, mode: "act", permissionMode: "trusted", attachments: undefined, title: undefined, prompt: "Work in the cloud" } as const;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "openorc-cloud-only-"));
  checkout = path.join(root, "app");
  await mkdir(checkout);
  await git(checkout, ["init", "-q", "-b", "main"]);
  await git(checkout, ["config", "user.email", "fixture@example.com"]);
  await git(checkout, ["config", "user.name", "Fixture"]);
  await writeFile(path.join(checkout, "README.md"), "# Cloud only\n");
  await commitAll(checkout, "Fixture baseline");
  claude = path.join(root, "claude");
  await writeFile(claude, FAKE_CLAUDE, { mode: 0o755 });
  opened = [];
});

afterEach(async () => {
  await core.close();
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe("a cloud-only core", () => {
  it("starts a project conversation in a Vercel sandbox when the request did not ask for the cloud", async () => {
    await open(cloudOnly);
    const local = vi.spyOn(ClaudeAdapter.prototype, "start");
    const { thread, run } = await core.threads.start({ ...start, projectId: project.id, cloud: false });
    expect(run).toBeNull();
    expect(core.cloud.get(thread.id)).toMatchObject({ provider: "vercel", sandbox: `openorc-${thread.id}` });
    expect(threadQueue.list(core.db, thread.id).map((message) => message.text)).toEqual(["Work in the cloud"]);
    await vi.waitFor(() => expect(core.cloud.state(thread.id)?.state).toBe("failed"), { timeout: 10_000 });
    expect(opened).toEqual([`openorc-${thread.id}`]);
    expect(local).not.toHaveBeenCalled();
  });

  it("starts a thread from GitHub's branch when the copy has nothing of its own, and from the copy when it holds the Mac's", async () => {
    const github = path.join(root, "github.git");
    await git(root, ["clone", "-q", "--bare", checkout, github]);
    await git(checkout, ["remote", "add", "origin", github]);
    const clone = path.join(root, "someone");
    await git(root, ["clone", "-q", github, clone]);
    await writeFile(path.join(clone, "pushed.md"), "pushed to GitHub\n");
    await git(clone, ["add", "-A"]);
    await git(clone, ["-c", "user.email=f@example.com", "-c", "user.name=F", "commit", "-qm", "Pushed"]);
    await git(clone, ["push", "-q", "origin", "HEAD:main"]);
    const pushed = (await git(clone, ["rev-parse", "HEAD"])).stdout.trim();
    await open(cloudOnly);
    const copyOf = async () => (await rpc("projects.list", {})).find((each) => each.id === project.id)?.copy;
    expect(await copyOf()).toBeUndefined();
    const began = Date.now();
    const behind = await core.threads.start({ ...start, projectId: project.id });
    await vi.waitFor(() => expect(core.threads.get(behind.thread.id)?.baseSha).toBe(pushed), { timeout: 10_000 });
    expect((await git(checkout, ["rev-parse", "main"])).stdout.trim()).toBe(pushed);
    expect((await copyOf())?.syncedAt).toBeGreaterThanOrEqual(began);
    expect((await rpc("projects.get", { id: project.id }))?.copy?.syncedAt).toBeGreaterThanOrEqual(began);

    await writeFile(path.join(checkout, "unpushed.md"), "only on the Mac\n");
    await commitAll(checkout, "Unpushed");
    const unpushed = (await git(checkout, ["rev-parse", "main"])).stdout.trim();
    const ahead = await core.threads.start({ ...start, projectId: project.id });
    await vi.waitFor(() => expect(core.threads.get(ahead.thread.id)?.baseSha).toBe(unpushed), { timeout: 10_000 });
  });

  it("stays busy from a conversation's start until its first message has been delivered", async () => {
    await open(cloudOnly);
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    onTestFinished(() => release());
    const continueThread = core.threads.continueThread.bind(core.threads);
    vi.spyOn(core.threads, "continueThread").mockImplementation(async (...args) => {
      await held;
      return continueThread(...args);
    });
    const { thread } = await core.threads.start({ ...start, projectId: project.id });
    expect(core.busy()).toBe("queued-messages");
    release();
    await vi.waitFor(() => expect(core.cloud.state(thread.id)?.state).toBe("failed"), { timeout: 10_000 });
    await vi.waitFor(() => expect(core.busy()).toBeNull());
  });

  it("refuses Workspace and checkout conversations, admitting nothing", async () => {
    await open(cloudOnly);
    const refusal = "Cloud conversations start in a project, on a worktree of their own.";
    await expect(core.threads.start({ ...start, projectId: WORKSPACE_ID })).rejects.toThrow(refusal);
    const baseSha = (await git(checkout, ["rev-parse", "HEAD"])).stdout.trim();
    await expect(core.threads.start({ ...start, projectId: project.id, checkout: { path: checkout, baseSha } })).rejects.toThrow(refusal);
    expect(threads.list(core.db)).toEqual([]);
  });

  it("refuses a task's run without a conversation at launch, before any agent starts", async () => {
    await open(cloudOnly);
    vi.spyOn(core.runs, "models").mockResolvedValue([]);
    const local = vi.spyOn(ClaudeAdapter.prototype, "start");
    const task = tasks.insert(core.db, { projectId: project.id, title: "Threadless", spec: "Do it here", priority: "none", labels: [], workspaceMode: "current", baseRef: "main", parentTaskId: null });
    await expect(
      core.runs.start({ scope: { task, thread: null }, project, agent: "claude", model: "fixture", mode: "act", permissionMode: "trusted", prompt: "Do it here", resume: false }),
    ).rejects.toThrow(LOCAL_LAUNCH_REFUSED);
    expect(local).not.toHaveBeenCalled();
  });

  it("gives agents no device tool and runs no device helper", async () => {
    const run = vi.spyOn(nodeSystem, "run");
    const spawn = vi.spyOn(nodeSystem, "spawn");
    await open(cloudOnly);
    expect(await tools()).not.toContain("device");
    await expect(rpc("devices.status", {})).rejects.toThrow("This machine has no simulators or emulators.");
    await core.devices.reapStale();
    expect(run).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("offers no place to choose", async () => {
    await open(cloudOnly);
    expect(await rpc("cloud.offer", {})).toEqual({ offered: false, provider: null });
  });

  it("counts a Claude account with a cloud token as signed in, and reads it again when the token goes", async () => {
    await open(cloudOnly);
    const ready = async () => (await rpc("claude.accounts.list", {})).accounts.find((account) => account.id === DEFAULT_CLAUDE_ACCOUNT)?.status;
    expect(await ready()).toBe("ready");
    expect(harnessLoggedIn(harnessInfo(await rpc("system.info", { claudeAccountId: DEFAULT_CLAUDE_ACCOUNT }), "claude"))).toBe(true);
    await core.claudeCloudTokens.remove(DEFAULT_CLAUDE_ACCOUNT);
    expect(await ready()).toBe("signed_out");
    expect(harnessLoggedIn(harnessInfo(await rpc("system.info", { claudeAccountId: DEFAULT_CLAUDE_ACCOUNT }), "claude"))).toBe(false);
  });
});

describe("a core that is not cloud-only", () => {
  it("keeps the device tool, the offer and Claude's sign-in as they were", async () => {
    await open({});
    expect(await tools()).toContain("device");
    expect(await rpc("cloud.offer", {})).toMatchObject({ offered: true });
    expect((await rpc("claude.accounts.list", {})).accounts.find((account) => account.id === DEFAULT_CLAUDE_ACCOUNT)?.status).toBe("signed_out");
  });
});
