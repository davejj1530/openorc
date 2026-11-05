import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BRAIN_PROJECT, brainLayout, newBrainKey, sealHandover, signInPrint, type BrainStart, type HandoverValues } from "@openorc/cloud";
import { OpenOrc, type ProtectedSecretStore } from "@openorc/core";
import { commitAll, git } from "@openorc/git";
import { DEFAULT_CLAUDE_ACCOUNT, type ThreadSummary } from "@openorc/protocol";
import { NO_SANDBOX } from "./awake.js";
import { BrainCloud, CLOUD_CHANNEL } from "./cloud.js";
import { controlHandlers } from "./control-ops.js";
import { BrainGitHub, GITHUB_CHANNEL } from "./github.js";
import { brainOptions } from "./options.js";
import { SealedSecrets } from "./secrets.js";

const vercel = { token: "vercel-token-fixture", teamId: "team_brain", projectId: "prj_brain" };
const AGENT37 = { key: "sk_live_fixture", cpu: 4, memory: 16 } as const;
const onVercel: BrainStart = { key: newBrainKey(), name: "Cloud", address: "sb-fixture.vercel.run", port: 47_820, vercel: { connection: vercel, sandbox: "brain" } };
const onAgent37: BrainStart = { key: newBrainKey(), name: "Cloud", address: "ab12cd34ef-47820.agent37.app", port: 47_820, vercel: null, agent37: { connection: AGENT37, instance: "ab12cd34ef" } };
const runOnAgent37: HandoverValues["cloud"] = { service: "agent37", agent37: AGENT37, vercel: { token: vercel.token, teamId: vercel.teamId, vcpus: 4, region: "fra1" } };

function memoryStore(): ProtectedSecretStore & { saved: string | null } {
  return {
    saved: null,
    async load() {
      return this.saved;
    },
    async save(value) {
      this.saved = value;
    },
  };
}

function cloudOn(start: BrainStart, store = memoryStore(), project?: (token: string, teamId: string, name: string) => Promise<{ id: string }>) {
  const warnings: string[] = [];
  const cloud = new BrainCloud({ store, start, self: { region: async () => "sin1" }, warn: (text) => warnings.push(text), ...(project ? { project } : {}) });
  return { cloud, store, warnings };
}

describe("BrainCloud", () => {
  it("runs threads where the brain lives until its Mac hands over where they run, as a brain of an older Mac does", async () => {
    const { cloud } = cloudOn(onVercel);
    await cloud.load();
    expect(await cloud.service()).toBe("vercel");
    expect(await cloud.vercel()).toEqual({ ...vercel, region: "sin1" });
    expect(await cloud.agent37()).toBeNull();
    expect(cloud.print()).toBeNull();

    const other = cloudOn(onAgent37).cloud;
    await other.load();
    expect(await other.service()).toBe("agent37");
    expect(await other.agent37()).toEqual(AGENT37);
    expect(await other.vercel()).toBeNull();
  });

  it("takes where threads run from the handover, sealed, so a restart keeps it", async () => {
    const { cloud, store } = cloudOn(onVercel);
    await cloud.load();
    await cloud.take(runOnAgent37);
    expect(await cloud.service()).toBe("agent37");
    expect(await cloud.agent37()).toEqual(AGENT37);

    const restarted = cloudOn(onVercel, store).cloud;
    await restarted.load();
    expect(await restarted.service()).toBe("agent37");
    expect(restarted.print()).toBe(signInPrint(runOnAgent37));
  });

  it("keeps Vercel sandboxes in the brain's own project: its start line's on its team, one found or made once on another", async () => {
    const { cloud } = cloudOn(onVercel);
    await cloud.take(runOnAgent37);
    expect(await cloud.vercel()).toEqual({ ...vercel, vcpus: 4, region: "fra1" });

    const asked: string[] = [];
    const project = async (_token: string, teamId: string, name: string) => {
      asked.push(`${teamId} ${name}`);
      return { id: "prj_made" };
    };
    const agent37Brain = cloudOn(onAgent37, memoryStore(), project).cloud;
    await agent37Brain.take({ service: "vercel", agent37: AGENT37, vercel: { token: "other-token", teamId: "team_mac" } });
    expect(await agent37Brain.vercel()).toEqual({ token: "other-token", teamId: "team_mac", projectId: "prj_made" });
    expect(await agent37Brain.vercel()).toEqual({ token: "other-token", teamId: "team_mac", projectId: "prj_made" });
    expect(asked).toEqual([`team_mac ${BRAIN_PROJECT}`]);
  });

  it("runs threads where the brain lives when the seal cannot be read, and says so", async () => {
    const store = memoryStore();
    store.load = async () => {
      throw new Error("sealed under another key");
    };
    const { cloud, warnings } = cloudOn(onAgent37, store);
    await cloud.load();
    expect(await cloud.service()).toBe("agent37");
    expect(warnings).toEqual(["Where new threads run could not be read, so they run where the brain lives until the Mac sends it again."]);
  });
});

describe("a brain's new threads", () => {
  let root: string;
  let start: BrainStart;
  let core: OpenOrc | null = null;
  let projectId: string;

  /** The brain's core as `serve` makes it, with its Mac's Claude sign-in handed over. */
  async function openBrain(): Promise<{ core: OpenOrc; ops: ReturnType<typeof controlHandlers> }> {
    const layout = brainLayout(root);
    // Where machine setup installs the agent CLIs: a thread starts only for an agent the brain has.
    await mkdir(path.join(layout.npm, "bin"), { recursive: true });
    await writeFile(path.join(layout.npm, "bin", "claude"), '#!/bin/sh\necho "2.1.0 (Claude Code)"\n', { mode: 0o755 });
    const secrets = await SealedSecrets.open(layout.secrets, start.key);
    const cloud = new BrainCloud({ store: secrets.store(CLOUD_CHANNEL), start, self: NO_SANDBOX, warn: () => undefined });
    await cloud.load();
    const brain = await OpenOrc.create(brainOptions({ layout, appDir: path.join(root, "app", "v1"), start, cloud, secrets, transport: { push() {} }, runnerFiles: [] }));
    const github = new BrainGitHub(secrets.store(GITHUB_CHANNEL), () => undefined);
    const ops = controlHandlers({ core: brain, key: start.key, layout, github, cloud, stop: () => undefined, answering: () => false });
    await ops(sealHandover(start.key, { claude: { accounts: [{ id: DEFAULT_CLAUDE_ACCOUNT, name: "Personal", default: true, token: "sk-ant-oat01-fixture" }] } }));
    return { core: brain, ops };
  }

  async function rpc(brain: OpenOrc, method: "threads.start" | "threads.get", params: unknown): Promise<unknown> {
    const reply = await brain.handle({ type: "rpc", id: 1, method, params });
    if (reply.type === "rpc.error") throw new Error(reply.message);
    return reply.result;
  }

  /** Where a thread started now runs, as the brain records it at once. */
  async function newThreadRunsOn(brain: OpenOrc): Promise<string | undefined> {
    const { thread } = (await rpc(brain, "threads.start", { projectId, cloud: true, agent: "claude", mode: "act", permissionMode: "autonomous", prompt: "Where do I run?" })) as {
      thread: { id: string };
    };
    return ((await rpc(brain, "threads.get", { id: thread.id })) as ThreadSummary).cloud?.provider;
  }

  beforeEach(async () => {
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), "openorc-brain-cloud-")));
    // Each thread's machine is asked for over the network; here every request is refused before it leaves.
    vi.stubGlobal("fetch", async () => {
      throw new Error("No network in this test.");
    });
  });

  afterEach(async () => {
    await core?.close();
    core = null;
    vi.unstubAllGlobals();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  async function withProject(brain: OpenOrc): Promise<void> {
    const checkout = path.join(root, "projects", "mac-project", "app");
    await git(root, ["init", "-q", "-b", "main", checkout]);
    await writeFile(path.join(checkout, "README.md"), "# Brain\n");
    await commitAll(checkout, "Baseline");
    projectId = (await brain.projects.import(checkout)).id;
  }

  it("of a brain on Vercel start on Agent37 once its Mac's Run on says so, while it runs and after a restart", async () => {
    start = { ...onVercel, key: newBrainKey() };
    const first = await openBrain();
    core = first.core;
    await withProject(core);
    expect(await first.ops(sealHandover(start.key, { cloud: runOnAgent37 }))).toEqual({ applied: ["cloud"] });
    expect(await newThreadRunsOn(core)).toBe("agent37");
    expect(await first.ops({ op: "sign-ins" })).toMatchObject({ cloud: signInPrint(runOnAgent37) });
    await core.close();

    core = (await openBrain()).core;
    expect(await newThreadRunsOn(core)).toBe("agent37");
  });

  it("of a brain its Mac never told start on the service the brain lives on", async () => {
    start = { ...onAgent37, key: newBrainKey() };
    core = (await openBrain()).core;
    await withProject(core);
    expect(await newThreadRunsOn(core)).toBe("agent37");
  });
});
