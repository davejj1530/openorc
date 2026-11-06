import { generateKeyPairSync } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BrainRefused,
  BrainUnavailable,
  openHandover,
  signInPrint,
  type BrainControlRequest,
  type BrainControlResults,
  type BrainHandover,
  type BrainKey,
  type BrainMachineStatus,
  type WakeResult,
} from "@openorc/cloud";
import { projects } from "@openorc/db";
import type { RpcMethod, RpcParams, RpcResults } from "@openorc/protocol";
import { OpenOrc } from "../openorc.js";
import type { BrainMachineLike } from "./cloud-brain-machine.js";
import { inheritedProbe } from "./shell-environment.js";

/**
 * The brain as far as the Mac can tell: it wakes, opens each handover with the key it was started with, and says what it
 * holds. An `old` one refuses every kind but Claude's and the read-back, as a brain from before them does.
 */
class FakeBrain implements BrainMachineLike {
  state: BrainMachineStatus["state"] = "missing";
  key: BrainKey | null = null;
  handovers: BrainHandover[] = [];
  holds: BrainControlResults["sign-ins"] = { codex: null, github: null, push: null, memory: null };
  wakes: WakeResult = { state: "ready", address: "sb-fixture.vercel.run", version: "v1" };
  installed: string | null = null;
  running: string | null = null;
  old = false;
  updateFails = false;
  beforeHandover: () => Promise<void> = async () => undefined;
  async status() {
    return { state: this.state, address: null, expiresAt: null };
  }
  async provision(bundle: { version: string }) {
    if (this.updateFails && this.installed) throw new Error("The upload stopped halfway.");
    if (this.state === "missing") this.state = "stopped";
    this.installed = bundle.version;
    return { installed: bundle.version, running: this.running };
  }
  async wake(input: { key: BrainKey }) {
    if (this.wakes.state !== "ready") return this.wakes;
    if (this.state !== "running") this.running = null;
    this.key = input.key;
    this.state = "running";
    this.running ??= this.installed;
    return { ...this.wakes, version: this.running ?? "v1" };
  }
  async control(request: BrainControlRequest): Promise<never> {
    if (this.state !== "running" || !this.key) throw new BrainUnavailable();
    if (request.op === "sign-ins" && !this.old) return this.holds as never;
    if (request.op !== "handover") throw new BrainRefused("The brain's control request is not valid: op is missing or wrong.");
    await this.beforeHandover();
    const opened = openHandover(this.key, request);
    const kinds = Object.keys(opened).filter((kind) => opened[kind as keyof BrainHandover] !== undefined);
    if (this.old && kinds.some((kind) => kind !== "claude")) throw new BrainRefused("The brain's control request is not valid: sealed has an unknown field.");
    this.handovers.push(opened);
    if (opened.codex !== undefined) this.holds.codex = opened.codex?.id ?? null;
    if (opened.github !== undefined) this.holds.github = opened.github && signInPrint(opened.github);
    if (opened.push !== undefined) this.holds.push = opened.push?.keyId ?? null;
    if (opened.memory !== undefined) this.holds.memory = opened.memory && signInPrint(opened.memory);
    if (opened.opencode !== undefined) this.holds.opencode = opened.opencode && signInPrint(opened.opencode);
    if (opened.cloud !== undefined) this.holds.cloud = signInPrint(opened.cloud);
    if (opened.env !== undefined) this.holds.env = opened.env && signInPrint(opened.env);
    return { applied: kinds } as never;
  }
  /** Each set of skills the brain took, by agent. */
  skillSends: Record<string, { name: string; files: { path: string; data: string }[] }[]>[] = [];
  async sendSkills(payload: Uint8Array, digest: string) {
    if (this.state !== "running" || !this.key) throw new BrainUnavailable();
    const { agents } = JSON.parse(Buffer.from(payload).toString("utf8")) as { agents: FakeBrain["skillSends"][number] };
    this.skillSends.push(agents);
    const kept = Object.values(agents).flat().length;
    this.holds.skills = kept ? digest : null;
    return { kept };
  }
  async importProject(): Promise<never> {
    throw new Error("unexpected import");
  }
  async remove() {
    this.state = "missing";
  }
  /** What the last handover carried besides Claude's list and where threads run, which follows Settings. */
  others(): Omit<BrainHandover, "claude" | "cloud"> {
    const { claude: _claude, cloud: _cloud, ...others } = this.handovers.at(-1) ?? {};
    return Object.fromEntries(Object.entries(others).filter(([, value]) => value !== undefined));
  }
  /** Where threads run, as the brain last took it. */
  cloud(): BrainHandover["cloud"] {
    return this.handovers.findLast((handover) => handover.cloud)?.cloud;
  }
}

/** Codex as the Mac's browser sign-in runs it: `login` leaves a ChatGPT login in CODEX_HOME, the app server says whose. */
const FAKE_CODEX = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("codex-cli 0.166.0"); process.exit(0); }
if (args[0] === "login") {
  fs.writeFileSync(path.join(process.env.CODEX_HOME, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: { refresh_token: "refresh-made-for-the-brain" }, last_refresh: new Date().toISOString() }));
  console.log("Successfully logged in");
  process.exit(0);
}
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  const result = message.method === "account/read" ? { account: { type: "chatgpt", email: "brain@example.com", planType: "pro" } } : {};
  process.stdout.write(JSON.stringify({ id: message.id, result }) + "\\n");
});
`;

/** The GitHub CLI as the Mac's pull requests use it: its token for github.com, from a file the test writes, or signed out. */
const FAKE_GH = `#!/bin/sh
if [ "$1 $2 $3 $4" = "auth token --hostname github.com" ] && [ -s "$FAKE_GH_TOKEN" ]; then cat "$FAKE_GH_TOKEN"; exit 0; fi
echo "no oauth token found for github.com" >&2
exit 1
`;

const PERSONAL = "sk-ant-oat01-personal-fixture-token-0123456789";
const GH_FIRST = "gho_firstFixtureToken0123456789";
const GH_SECOND = "gho_secondFixtureToken0123456789";
const API_KEY = "sk-fixture-brain-api-key-0123456789";
const MEMORY_KEY = "sk-ant-api03-mac-memory-fixture-0123456789";
const OLDER = "20261101000000-aaaaaaaaaaaa";
const NEWER = "20261104000000-bbbbbbbbbbbb";
const pushKey = (keyId = "ABC123DEFG") => ({ keyId, pem: generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ format: "pem", type: "pkcs8" }).toString() });

function memoryStore() {
  const saved: string[] = [];
  return { load: async () => saved.at(-1) ?? null, save: async (value: string) => void saved.push(value), saved };
}

let root: string;
let core: OpenOrc;
let brain: FakeBrain;
let record: ReturnType<typeof memoryStore>;
let claudeTokens: ReturnType<typeof memoryStore>;
let push: ReturnType<typeof memoryStore>;
let memoryKey: ReturnType<typeof memoryStore>;
let opencodeKeys: ReturnType<typeof memoryStore>;
let cloudEnv: ReturnType<typeof memoryStore>;
let ghToken: string;
let env: NodeJS.ProcessEnv;
/** The brain this Mac's build carries. */
let carried: string;

async function call<M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<RpcResults[M]> {
  const reply = await core.handle({ type: "rpc", id: 1, method, params });
  if (reply.type === "rpc.error") throw new Error(reply.message);
  return reply.result as RpcResults[M];
}

/** With `settings`, the cloud connections are Settings' own, kept there, as on a Mac; else a fixed Vercel connection. */
async function open(settings?: ReturnType<typeof memoryStore>): Promise<void> {
  const fixed = async () => ({ token: "vcp_fixture-vercel-token-0123456789", teamId: "team_fixture", projectId: "prj_sandboxes" });
  core = await OpenOrc.create({
    dataDir: path.join(root, `data-${Math.random().toString(36).slice(2)}`),
    ephemeral: true,
    transport: { push: () => undefined },
    shellProbe: inheritedProbe(env),
    claudeCloudSecrets: claudeTokens,
    codexCloudSecrets: memoryStore(),
    cloudBrainSecrets: record,
    pushSecrets: push,
    memorySecrets: memoryKey,
    opencodeCloudSecrets: opencodeKeys,
    cloudEnvSecrets: cloudEnv,
    ...(settings ? { cloudSecrets: settings } : { cloudCredentials: fixed }),
    cloudBrainBundle: async () => ({ version: carried, read: async () => Buffer.from("archive") }),
    cloudBrainMachine: async () => brain,
  });
}

async function setUp(): Promise<void> {
  await call("cloud.brain.create", { region: "sin1" });
  await vi.waitFor(async () => expect((await call("cloud.brain.status", {})).state).toBe("ready"));
}

const signIns = () => call("cloud.brain.signIns", {});
const brainError = async () => {
  const status = await call("cloud.brain.status", {});
  return "error" in status ? status.error : null;
};
/** Everything this Mac kept about the brain, as saved. */
const kept = () => record.saved.join("\n");

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "openorc-brain-signins-"));
  const bin = path.join(root, "bin");
  await mkdir(bin);
  await writeFile(path.join(bin, "codex"), FAKE_CODEX);
  await writeFile(path.join(bin, "gh"), FAKE_GH);
  await chmod(path.join(bin, "codex"), 0o755);
  await chmod(path.join(bin, "gh"), 0o755);
  ghToken = path.join(root, "gh-token");
  const gitconfig = path.join(root, "gitconfig");
  await writeFile(gitconfig, "[user]\n\tname = Fixture Person\n\temail = fixture@example.com\n");
  env = { ...process.env, PATH: `${bin}:${process.env["PATH"] ?? ""}`, OPENORC_CODEX_BIN: path.join(bin, "codex") };
  // This Mac's own gh and git settings are never read.
  vi.stubEnv("PATH", env["PATH"]!);
  vi.stubEnv("FAKE_GH_TOKEN", ghToken);
  vi.stubEnv("GIT_CONFIG_GLOBAL", gitconfig);
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  brain = new FakeBrain();
  carried = OLDER;
  record = memoryStore();
  claudeTokens = memoryStore();
  push = memoryStore();
  memoryKey = memoryStore();
  opencodeKeys = memoryStore();
  cloudEnv = memoryStore();
  await open();
});

afterEach(async () => {
  await core.close();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe("the cloud brain's sign-ins besides Claude", () => {
  it("signs the brain in to Codex with a login made for it alone, which this Mac forgets once the brain took it", async () => {
    await core.claudeCloudTokens.save("claude-cli", PERSONAL);
    await setUp();
    expect(brain.others()).toEqual({});
    await call("cloud.brain.codex.signIn", {});
    await vi.waitFor(() => expect(brain.others().codex).toBeDefined(), { timeout: 10_000 });
    expect(brain.others().codex).toMatchObject({ mode: "chatgpt", email: "brain@example.com", plan: "pro" });
    expect(brain.others().codex!.auth).toContain("refresh-made-for-the-brain");
    await vi.waitFor(async () => expect((await signIns()).codex).toEqual({ mode: "chatgpt", email: "brain@example.com", plan: "pro", signingIn: false, pending: null, error: null }), {
      timeout: 10_000,
    });
    // This Mac's own cloud login is another one, untouched.
    expect((await core.codexCloudLogin.status()).mode).toBeNull();
    expect(JSON.parse(record.saved.at(-1)!)).not.toHaveProperty("codexNext");

    await call("cloud.brain.handover", {});
    expect(brain.others()).toEqual({});
    await call("cloud.brain.codex.apiKey", { key: API_KEY });
    await vi.waitFor(() => expect(brain.others().codex).toMatchObject({ mode: "apiKey", email: null }), { timeout: 10_000 });
    expect(JSON.parse(brain.others().codex!.auth)).toEqual({ auth_mode: "apikey", OPENAI_API_KEY: API_KEY });
    await vi.waitFor(async () => expect((await signIns()).codex).toMatchObject({ mode: "apiKey", pending: null }), { timeout: 10_000 });
    expect(JSON.parse(record.saved.at(-1)!)).not.toHaveProperty("codexNext");
    await call("cloud.brain.codex.remove", {});
    await vi.waitFor(() => expect(brain.others()).toEqual({ codex: null }), { timeout: 10_000 });
    await vi.waitFor(async () => expect((await signIns()).codex).toMatchObject({ mode: null, pending: null }), { timeout: 10_000 });
  }, 20_000);

  it("keeps a Codex login the brain could not take until its next wake, then forgets it", async () => {
    await setUp();
    brain.state = "stopped";
    brain.wakes = { state: "failed", detail: "Vercel is down." };
    await call("cloud.brain.codex.apiKey", { key: API_KEY });
    await vi.waitFor(async () => expect(await brainError()).toContain("Vercel is down."));
    expect(await signIns()).toMatchObject({ codex: { mode: null, pending: { mode: "apiKey", email: null, plan: null } } });
    expect(record.saved.at(-1)).toContain(API_KEY);

    brain.wakes = { state: "ready", address: "sb-fixture.vercel.run", version: "v1" };
    await call("cloud.brain.wake", {});
    expect(brain.others().codex).toMatchObject({ mode: "apiKey" });
    expect(await signIns()).toMatchObject({ codex: { mode: "apiKey", pending: null } });
    expect(record.saved.at(-1)).not.toContain(API_KEY);
  });

  it("sends the GitHub CLI's sign-in only once switched on, again when it changes, and deletes it when switched off", async () => {
    await writeFile(ghToken, `${GH_FIRST}\n`);
    await setUp();
    expect(brain.others()).toEqual({});
    expect((await signIns()).github).toEqual({ on: false, blocked: null, behind: false });

    expect((await call("cloud.brain.github", { on: true })).github).toEqual({ on: true, blocked: null, behind: false });
    expect(brain.others()).toEqual({ github: { token: GH_FIRST, name: "Fixture Person", email: "fixture@example.com" } });
    expect(kept()).not.toContain(GH_FIRST);

    await writeFile(ghToken, `${GH_SECOND}\n`);
    // A new core, as after this Mac restarts: its first look at gh is fresh.
    await core.close();
    await open();
    expect((await signIns()).github).toEqual({ on: true, blocked: null, behind: true });
    await call("cloud.brain.wake", {});
    expect(brain.others()).toEqual({ github: { token: GH_SECOND, name: "Fixture Person", email: "fixture@example.com" } });

    expect((await call("cloud.brain.github", { on: false })).github).toEqual({ on: false, blocked: null, behind: false });
    expect(brain.others()).toEqual({ github: null });
    const handed = brain.handovers.length;
    await call("cloud.brain.handover", {});
    expect(brain.handovers).toHaveLength(handed + 1);
    expect(brain.others()).toEqual({});
  });

  it("will not switch GitHub on while this Mac's GitHub CLI is signed out, and says why", async () => {
    await setUp();
    const blocked = "The GitHub CLI isn't signed in to github.com on this Mac.";
    expect((await signIns()).github).toEqual({ on: false, blocked, behind: false });
    expect((await call("cloud.brain.github", { on: true })).github).toEqual({ on: false, blocked, behind: false });
    expect(await brainError()).toBe(blocked);
    expect(brain.others()).toEqual({});
  });

  it("hands the brain this Mac's push key, again when it changes, and takes it away when it is removed", async () => {
    const first = pushKey();
    await call("remote.push.setKey", first);
    await setUp();
    expect(brain.others()).toEqual({ push: first });
    expect(await signIns()).toMatchObject({ push: { has: true, behind: false } });
    expect(kept()).not.toContain("PRIVATE KEY");

    brain.state = "stopped";
    const second = pushKey("XYZ987WVUT");
    await call("remote.push.setKey", second);
    await vi.waitFor(() => expect(brain.others()).toEqual({ push: second }));
    expect(brain.state).toBe("running");
    await call("remote.push.removeKey", {});
    await vi.waitFor(() => expect(brain.others()).toEqual({ push: null }));
    await vi.waitFor(async () => expect((await signIns()).push).toEqual({ has: false, behind: false }));
  });
  it("hands the brain this Mac's memory key only while memory is on with it, and takes it away when either stops", async () => {
    await setUp();
    await call("memory.settings.set", { enabled: true, provider: "apikey", apiKey: MEMORY_KEY });
    await vi.waitFor(() => expect(brain.others()).toEqual({ memory: { apiKey: MEMORY_KEY } }));
    await vi.waitFor(async () => expect((await signIns()).memory).toEqual({ has: true, behind: false }));
    expect(kept()).not.toContain(MEMORY_KEY);

    brain.state = "stopped";
    await call("memory.settings.set", { provider: "claude" });
    await vi.waitFor(() => expect(brain.others()).toEqual({ memory: null }));
    expect(brain.state).toBe("running");
    await call("memory.settings.set", { provider: "apikey" });
    await vi.waitFor(() => expect(brain.others()).toEqual({ memory: { apiKey: MEMORY_KEY } }));
    await call("memory.settings.set", { enabled: false });
    await vi.waitFor(() => expect(brain.others()).toEqual({ memory: null }));
    await call("memory.settings.set", { enabled: true });
    await vi.waitFor(() => expect(brain.others()).toEqual({ memory: { apiKey: MEMORY_KEY } }));
    await call("memory.settings.set", { apiKey: "" });
    await vi.waitFor(() => expect(brain.others()).toEqual({ memory: null }));
    await vi.waitFor(async () => expect((await signIns()).memory).toEqual({ has: false, behind: false }));
  });

  it("hands the brain OpenCode's cloud keys, again when they change, and takes them away when the last is removed", async () => {
    await setUp();
    await call("cloud.opencode.saveKey", { provider: "openrouter", key: "sk-or-fixture-key-1" });
    await vi.waitFor(() => expect(brain.others()).toEqual({ opencode: { keys: [{ provider: "openrouter", key: "sk-or-fixture-key-1" }] } }));
    expect(kept()).not.toContain("sk-or-fixture-key-1");
    expect(await call("cloud.status", {})).toMatchObject({ opencode: { providers: ["openrouter"] } });
    expect(JSON.stringify(await call("cloud.status", {}))).not.toContain("sk-or-fixture-key-1");
    await call("cloud.opencode.saveKey", { provider: "anthropic", key: "sk-ant-fixture-key-2" });
    await vi.waitFor(() =>
      expect(brain.others()).toEqual({
        opencode: {
          keys: [
            { provider: "anthropic", key: "sk-ant-fixture-key-2" },
            { provider: "openrouter", key: "sk-or-fixture-key-1" },
          ],
        },
      }),
    );
    await call("cloud.opencode.removeKey", { provider: "anthropic" });
    await call("cloud.opencode.removeKey", { provider: "openrouter" });
    await vi.waitFor(() => expect(brain.others()).toEqual({ opencode: null }));
  });

  it("hands the brain each project's cloud environment, again when it changes, and takes it away when the last is removed", async () => {
    const project = projects.insert(core.db, { name: "Fixture", rootPath: root, gitRemote: null, defaultBranch: "main", settings: { setupScript: null, worktreeInclude: [] } });
    await setUp();
    expect(await call("cloud.env.set", { projectId: project.id, entries: [{ name: "API_URL", value: "https://dev.example" }] })).toEqual({ projectId: project.id, names: ["API_URL"] });
    await vi.waitFor(() => expect(brain.others()).toEqual({ env: { projects: [{ source: project.id, vars: [{ name: "API_URL", value: "https://dev.example" }] }] } }));
    expect(kept()).not.toContain("dev.example");
    expect(await call("cloud.env", { projectId: project.id })).toEqual({ projectId: project.id, names: ["API_URL"] });
    await vi.waitFor(async () => expect((await signIns()).env).toEqual({ has: true, behind: false }));
    await call("cloud.env.set", { projectId: project.id, entries: [{ name: "API_URL" }, { name: "DEBUG", value: "1" }] });
    await vi.waitFor(() =>
      expect(brain.others()).toEqual({
        env: {
          projects: [
            {
              source: project.id,
              vars: [
                { name: "API_URL", value: "https://dev.example" },
                { name: "DEBUG", value: "1" },
              ],
            },
          ],
        },
      }),
    );
    await call("cloud.env.set", { projectId: project.id, entries: [] });
    await vi.waitFor(() => expect(brain.others()).toEqual({ env: null }));
    await vi.waitFor(async () => expect((await signIns()).env).toEqual({ has: false, behind: false }));
  });

  it("hands the brain the skills chosen for cloud sessions, again when they change, and none once none are chosen", async () => {
    const home = path.join(root, "home");
    const claudeDir = path.join(home, ".claude");
    const skillFile = path.join(claudeDir, "skills", "review", "SKILL.md");
    await mkdir(path.dirname(skillFile), { recursive: true });
    await writeFile(skillFile, "---\nname: review\ndescription: Reviews a diff\n---\nFirst\n");
    const opencode = path.join(root, "bin", "opencode");
    await writeFile(opencode, "#!/bin/sh\nexit 1\n");
    await chmod(opencode, 0o755);
    // Every agent's own folders here are the fixture's, never this Mac's.
    const own = { HOME: home, CLAUDE_CONFIG_DIR: claudeDir, XDG_CONFIG_HOME: path.join(home, ".config"), OPENORC_OPENCODE_BIN: opencode };
    Object.assign(env, own);
    for (const [name, value] of Object.entries(own)) vi.stubEnv(name, value);
    await core.close();
    await open();
    await setUp();
    const claude = async () => (await call("cloud.skills", {})).agents.find((agent) => agent.agent === "claude");
    expect(await claude()).toEqual({ agent: "claude", skills: [{ name: "review", description: "Reviews a diff", chosen: false }], error: null });
    expect(brain.skillSends).toEqual([]);
    await call("cloud.skills.choose", { agent: "claude", name: "review", on: true });
    await vi.waitFor(() => expect(brain.skillSends.at(-1)?.["claude"]?.map((skill) => skill.name)).toEqual(["review"]));
    expect(brain.skillSends.at(-1)?.["codex"]).toEqual([]);
    await vi.waitFor(async () => expect((await signIns()).skills).toEqual({ has: true, behind: false }));
    await writeFile(skillFile, "---\nname: review\ndescription: Reviews a diff\n---\nSecond\n");
    expect((await signIns()).skills).toEqual({ has: true, behind: true });
    await call("cloud.brain.wake", {});
    await vi.waitFor(() => expect(brain.skillSends).toHaveLength(2));
    expect(Buffer.from(brain.skillSends[1]!["claude"]![0]!.files.find((file) => file.path === "SKILL.md")!.data, "base64").toString()).toContain("Second");
    await call("cloud.skills.choose", { agent: "claude", name: "review", on: false });
    await vi.waitFor(() => expect(brain.holds.skills).toBeNull());
    await vi.waitFor(async () => expect((await signIns()).skills).toEqual({ has: false, behind: false }));
  });

  it("gives the memory key again to a brain that lost it, though it holds nothing else", async () => {
    await call("memory.settings.set", { enabled: true, provider: "apikey", apiKey: MEMORY_KEY });
    await setUp();
    expect(brain.holds.memory).toBe(signInPrint({ apiKey: MEMORY_KEY }));
    brain.holds.memory = null;
    const handed = brain.handovers.length;
    await call("cloud.brain.wake", {});
    await vi.waitFor(() => expect(brain.handovers).toHaveLength(handed + 1));
    expect(brain.others()).toEqual({ memory: { apiKey: MEMORY_KEY } });
  });

  it("hands a brain still on an older version Claude's sign-ins alone, keeping the failed update in view", async () => {
    await core.claudeCloudTokens.save("claude-cli", PERSONAL);
    await setUp();
    brain.old = true;
    brain.updateFails = true;
    carried = NEWER;
    await core.close();
    await open();
    await call("remote.push.setKey", pushKey());
    await vi.waitFor(() => expect(brain.handovers).toHaveLength(2));
    expect(brain.handovers[1]!.claude?.accounts.map((account) => account.id)).toEqual(["claude-cli"]);
    expect(brain.others()).toEqual({});
    await vi.waitFor(async () => expect(await brainError()).toBe("The cloud brain could not be updated. The upload stopped halfway."));
    expect(await signIns()).toMatchObject({ push: { has: false, behind: true } });
    await call("cloud.brain.wake", {});
    expect(await brainError()).toBe("The cloud brain could not be updated. The upload stopped halfway.");
  });

  it("takes the brain's word for what it holds, so one back on an empty snapshot gets them again", async () => {
    const key = pushKey();
    await call("remote.push.setKey", key);
    await writeFile(ghToken, `${GH_FIRST}\n`);
    await call("memory.settings.set", { enabled: true, provider: "apikey", apiKey: MEMORY_KEY });
    await setUp();
    await call("cloud.brain.github", { on: true });
    await call("cloud.brain.codex.apiKey", { key: API_KEY });
    await vi.waitFor(async () => expect((await signIns()).codex).toMatchObject({ mode: "apiKey", pending: null }));
    expect(brain.holds).toMatchObject({ github: expect.any(String), push: key.keyId, memory: expect.any(String) });

    brain.holds = { codex: null, github: null, push: null, memory: null };
    const handed = brain.handovers.length;
    await call("cloud.brain.wake", {});
    await vi.waitFor(() => expect(brain.handovers).toHaveLength(handed + 1));
    expect(brain.others()).toEqual({ github: { token: GH_FIRST, name: "Fixture Person", email: "fixture@example.com" }, push: key, memory: { apiKey: MEMORY_KEY } });
    await vi.waitFor(async () => expect(await signIns()).toMatchObject({ codex: { mode: null, pending: null }, github: { on: true, behind: false }, push: { has: true, behind: false } }));
  });

  it("shows a Codex login, or its sign-out, as waiting for the brain at once, while what runs before it finishes", async () => {
    await setUp();
    /** A handover held at the brain until the returned function lets it finish. */
    const held = async () => {
      let release!: () => void;
      const reached = new Promise<void>((resolve) => {
        brain.beforeHandover = () => {
          resolve();
          return new Promise((done) => (release = done));
        };
      });
      const before = call("cloud.brain.handover", {});
      await reached;
      brain.beforeHandover = async () => undefined;
      return () => {
        release();
        return before;
      };
    };
    let finish = await held();
    await call("cloud.brain.codex.apiKey", { key: API_KEY });
    expect((await signIns()).codex).toMatchObject({ mode: null, pending: { mode: "apiKey" } });
    expect(record.saved.at(-1)).not.toContain(API_KEY);
    await finish();
    await vi.waitFor(async () => expect((await signIns()).codex).toMatchObject({ mode: "apiKey", pending: null }));

    finish = await held();
    await call("cloud.brain.codex.remove", {});
    expect((await signIns()).codex).toMatchObject({ mode: "apiKey", pending: "sign-out" });
    await finish();
    await vi.waitFor(async () => expect((await signIns()).codex).toMatchObject({ mode: null, pending: null }));
    expect(brain.others()).toEqual({ codex: null });
  });

  it("asks this Mac's GitHub CLI again when the switch moves, and says why nothing went while it is on", async () => {
    await setUp();
    expect((await signIns()).github.blocked).toBe("The GitHub CLI isn't signed in to github.com on this Mac.");
    await writeFile(ghToken, `${GH_FIRST}\n`);
    brain.state = "stopped";
    brain.wakes = { state: "failed", detail: "Vercel is down." };
    expect((await call("cloud.brain.github", { on: true })).github).toEqual({ on: true, blocked: null, behind: true });
    await rm(ghToken);
    await core.close();
    await open();
    expect((await signIns()).github).toEqual({ on: true, blocked: "The GitHub CLI isn't signed in to github.com on this Mac.", behind: false });
  });
});

describe("where the cloud brain's threads run", () => {
  const VERCEL = {
    token: "vcp_fixture-vercel-token-0123456789",
    team: { id: "team_fixture", name: "Fixture" },
    project: { id: "prj_sandboxes", name: "openorc-sandboxes" },
    region: "fra1",
    reach: "account",
  };
  const AGENT37_KEY = "sk_live_fixture-agent37-key";

  beforeEach(async () => {
    await core.close();
    const settings = memoryStore();
    await settings.save(JSON.stringify({ vercel: VERCEL, agent37: { key: AGENT37_KEY }, service: "vercel" }));
    await open(settings);
  });

  it("follows Run on: at setup, at once to a running brain, and at the next wake to an asleep one, which nothing wakes for it", async () => {
    await setUp();
    expect(brain.cloud()).toEqual({ service: "vercel", agent37: { key: AGENT37_KEY, cpu: 2, memory: 4 }, vercel: { token: VERCEL.token, teamId: "team_fixture", region: "fra1" } });

    await call("cloud.service", { service: "agent37" });
    await vi.waitFor(() => expect(brain.cloud()?.service).toBe("agent37"));

    brain.state = "stopped";
    await call("cloud.agent37.size", { size: { cpu: 4, memory: 16 } });
    // Queued behind the change: once it ran, the brain still sleeps, with what it had.
    await call("cloud.brain.recount", {});
    expect(brain.state).toBe("stopped");
    expect(brain.cloud()?.agent37).toEqual({ key: AGENT37_KEY, cpu: 2, memory: 4 });
    expect(await brainError()).toBeNull();

    await call("cloud.brain.wake", {});
    expect(brain.cloud()).toMatchObject({ service: "agent37", agent37: { key: AGENT37_KEY, cpu: 4, memory: 16 } });
  });

  it("gives it again to a brain that lost it, though it holds nothing else", async () => {
    await setUp();
    brain.state = "stopped";
    brain.holds.cloud = null;
    const before = brain.handovers.length;
    await call("cloud.brain.wake", {});
    await vi.waitFor(() => expect(brain.handovers.length).toBeGreaterThan(before));
    expect(brain.handovers.at(-1)?.cloud).toMatchObject({ service: "vercel" });
  });
});
