import { generateKeyPairSync, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { brainKeyText, brainLayout, bundleBranch, newBrainKey, sealHandover, signInPrint, type BrainControlResults, type BrainLayout, type BrainStart, type ProjectCopy } from "@openorc/cloud";
import { OpenOrc } from "@openorc/core";
import { DEFAULT_CLAUDE_ACCOUNT } from "@openorc/protocol";
import { claudeAccounts, threads } from "@openorc/db";
import { commitAll, git, run, useGitHubSignIn } from "@openorc/git";
import { NO_SANDBOX } from "./awake.js";
import { controlHandlers, retireSignedOut } from "./control-ops.js";
import { BrainGitHub, GITHUB_CHANNEL } from "./github.js";
import { brainOptions } from "./options.js";
import { SealedSecrets } from "./secrets.js";

const TOKEN = "sk-ant-oat01-handed-over-fixture-token";
const WORK_TOKEN = "sk-ant-oat01-handed-over-work-token";
const WORK = "4c1f0a52-7a0e-4b44-9d7e-1f0c2a6b8e11";
const personal = { id: DEFAULT_CLAUDE_ACCOUNT, name: "Personal", default: true, token: TOKEN };
const work = { id: WORK, name: "Work", default: false, token: WORK_TOKEN };

let root: string;
let layout: BrainLayout;
let start: BrainStart;
let core: OpenOrc;
let stops = 0;
let answering = false;
let warnings: string[] = [];
let invalidated: string[] = [];
const transport = { push: (message: { type: string; keys?: string[] }) => void (message.type === "invalidate" && invalidated.push(...(message.keys ?? []))) };
let github: BrainGitHub;

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "openorc-brain-ops-")));
  layout = brainLayout(root);
  start = { key: newBrainKey(), name: "Cloud", address: "localhost", port: 0, vercel: null };
  const secrets = await SealedSecrets.open(layout.secrets, start.key);
  // The brain's own Codex, which has no login of its own there: only the cloud login it is handed signs it in.
  await mkdir(path.join(layout.npm, "bin"), { recursive: true });
  await writeFile(path.join(layout.npm, "bin", "codex"), '#!/bin/sh\ncase "$1" in --version) echo "codex-cli 0.166.0";; login) echo "Not logged in"; exit 1;; esac\n');
  await chmod(path.join(layout.npm, "bin", "codex"), 0o755);
  warnings = [];
  github = new BrainGitHub(secrets.store(GITHUB_CHANNEL), (text) => warnings.push(text));
  useGitHubSignIn(() => github.environment());
  core = await OpenOrc.create({ ...brainOptions({ layout, appDir: path.join(root, "app", "v1"), start, self: NO_SANDBOX, secrets, transport, runnerFiles: [] }), ephemeral: true });
  stops = 0;
  answering = false;
});

afterEach(async () => {
  useGitHubSignIn(() => ({}));
  await core.close();
  await rm(root, { recursive: true, force: true });
});

const ops = () => controlHandlers({ core, key: start.key, layout, github, stop: () => stops++, answering: () => answering });

const GH_TOKEN = "gho_handedOverFixtureToken0123456789";
/** A ChatGPT login file as Codex writes it, last refreshed `ms` from now. */
const codexAuth = (stamp: string, ms: number) => JSON.stringify({ auth_mode: "chatgpt", tokens: { refresh_token: `refresh-${stamp}` }, last_refresh: new Date(Date.now() + ms).toISOString() });
/** Git with none of this Mac's own settings, so no credential helper of the person's is ever asked. */
const isolatedGit = { PATH: process.env["PATH"], HOME: os.tmpdir(), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" };

async function rpc(method: "agents.availability" | "remote.status"): Promise<unknown> {
  const reply = await core.handle({ type: "rpc", id: 1, method, params: {} });
  if (reply.type === "rpc.error") throw new Error(reply.message);
  return reply.result;
}

async function sealedBytes(): Promise<string> {
  const names = await readdir(layout.secrets);
  return (await Promise.all(names.map((name) => readFile(path.join(layout.secrets, name), "latin1")))).join("\n");
}

describe("control requests on the brain's core", () => {
  it("keeps a handed-over Claude token sealed, and the core signs in with it", async () => {
    expect(await ops()(sealHandover(start.key, { claude: { accounts: [personal] } }))).toEqual({ applied: ["claude"] });
    expect(core.claudeCloudTokens.known(DEFAULT_CLAUDE_ACCOUNT)).toBe(TOKEN);
    const bytes = await sealedBytes();
    expect(bytes).not.toContain(TOKEN);
    expect(bytes).not.toContain(brainKeyText(start.key));
    expect(await (await SealedSecrets.open(layout.secrets, start.key)).store("claude-cloud").load()).toContain(TOKEN);
  });

  it("refuses a handover sealed under another key, applying nothing", async () => {
    await expect(ops()(sealHandover(newBrainKey(), { claude: { accounts: [personal] } }))).rejects.toThrow("does not open with this brain key");
    expect(core.claudeCloudTokens.known(DEFAULT_CLAUDE_ACCOUNT)).toBeNull();
  });

  it("takes a Codex login made for it alone, keeps what it refreshed when the same one comes again, and signs out on null", async () => {
    const login = { id: "mac-login-1", mode: "chatgpt", auth: codexAuth("first", 0), email: "qa@example.com", plan: "plus" } as const;
    expect(await ops()(sealHandover(start.key, { codex: login }))).toEqual({ applied: ["codex"] });
    expect(await core.codexCloudLogin.status()).toMatchObject({ mode: "chatgpt", email: "qa@example.com", plan: "plus" });
    expect(await core.codexCloudLogin.forSandbox()).toBe(login.auth);
    expect(await sealedBytes()).not.toContain("refresh-first");
    const refreshed = codexAuth("refreshed-here", 5_000);
    await core.codexCloudLogin.keep(refreshed);
    await ops()(sealHandover(start.key, { codex: login }));
    expect(await core.codexCloudLogin.forSandbox()).toBe(refreshed);
    const next = { ...login, id: "mac-login-2", mode: "apiKey", auth: '{"auth_mode":"apikey","OPENAI_API_KEY":"sk-fixture-0123456789"}', email: null, plan: null } as const;
    await ops()(sealHandover(start.key, { codex: next }));
    expect(await core.codexCloudLogin.forSandbox()).toBe(next.auth);
    await ops()(sealHandover(start.key, { codex: null }));
    expect(await core.codexCloudLogin.status()).toMatchObject({ mode: null });
    expect(await core.codexCloudLogin.forSandbox()).toBeNull();
  });

  it("offers Codex to phones only while it has a cloud login, its own CLI having none", async () => {
    const codex = async () => ((await rpc("agents.availability")) as { id: string; state: string }[]).find((row) => row.id === "codex")?.state;
    expect(await codex()).toBe("sign_in");
    invalidated = [];
    await ops()(sealHandover(start.key, { codex: { id: "mac-login-1", mode: "chatgpt", auth: codexAuth("first", 0), email: null, plan: null } }));
    expect(invalidated).toEqual(expect.arrayContaining(["system", "models"]));
    expect(await codex()).toBe("ready");
    await ops()(sealHandover(start.key, { codex: null }));
    expect(await codex()).toBe("sign_in");
  });

  it("keeps the Mac's GitHub sign-in sealed and gives it to the core's git and gh alone, at once, until it is taken away", async () => {
    const signIn = { token: GH_TOKEN, name: "Fixture Person", email: "fixture@example.com" };
    expect(await ops()(sealHandover(start.key, { github: signIn }))).toEqual({ applied: ["github"] });
    expect(await sealedBytes()).not.toContain(GH_TOKEN);
    const bin = path.join(root, "bin");
    await mkdir(bin);
    await writeFile(path.join(bin, "gh"), '#!/bin/sh\nprintf %s "$GH_TOKEN"\n');
    await chmod(path.join(bin, "gh"), 0o755);
    const env = { ...isolatedGit, PATH: `${bin}:${process.env["PATH"] ?? ""}` };
    const gitOut = async (args: string[], input?: string) => (await git(root, args, { env, okCodes: [0, 128], ...(input ? { input } : {}) })).stdout.trim();
    expect((await gitOut(["config", "--get-all", "credential.https://github.com.helper"])).split("\n")).toHaveLength(1);
    expect((await gitOut(["credential", "fill"], "protocol=https\nhost=github.com\n\n")).split("\n")).toContain(`password=${GH_TOKEN}`);
    expect(await gitOut(["ls-remote", "--get-url", "git@github.com:example/my-app.git"])).toBe("https://github.com/example/my-app.git");
    expect(await gitOut(["var", "GIT_AUTHOR_IDENT"])).toMatch(/^Fixture Person <fixture@example\.com> /);
    expect((await run("gh", root, ["auth", "token"], { env })).stdout).toBe(GH_TOKEN);
    // Every other program the brain starts, its background Claude included, inherits none of it.
    expect((await run("sh", root, ["-c", 'printf %s "$GH_TOKEN"'], { env })).stdout).toBe("");
    expect(process.env["GH_TOKEN"]).toBeUndefined();
    expect(JSON.stringify(core.claudeAccounts.inspectionEnvironment(core.environment.current()))).not.toContain(GH_TOKEN);

    const restarted = new BrainGitHub((await SealedSecrets.open(layout.secrets, start.key)).store(GITHUB_CHANNEL), (text) => warnings.push(text));
    await restarted.load();
    expect(restarted.environment()).toEqual(github.environment());
    await ops()(sealHandover(start.key, { github: null }));
    expect(await gitOut(["credential", "fill"], "protocol=https\nhost=github.com\n\n")).not.toContain("password=");
    expect(await gitOut(["ls-remote", "--get-url", "git@github.com:example/my-app.git"])).toBe("git@github.com:example/my-app.git");
    await restarted.load();
    expect([restarted.environment(), warnings]).toEqual([{}, []]);
  });

  it("starts without the GitHub sign-in, saying why, when its sealed file cannot be read", async () => {
    await writeFile(path.join(layout.secrets, `${GITHUB_CHANNEL}.sealed`), "not sealed");
    const restarted = new BrainGitHub((await SealedSecrets.open(layout.secrets, start.key)).store(GITHUB_CHANNEL), (text) => warnings.push(text));
    await restarted.load();
    expect([restarted.environment(), warnings]).toEqual([{}, ["The GitHub sign-in could not be read, so it is off until the Mac sends it again."]]);
  });

  it("says which sign-ins it holds besides Claude's, so the Mac takes its word over its own record", async () => {
    expect(await ops()({ op: "sign-ins" })).toEqual({ codex: null, github: null, push: null });
    const signIn = { token: GH_TOKEN, name: null, email: "fixture@example.com" };
    const pem = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    const codex = { id: "mac-login-1", mode: "chatgpt", auth: codexAuth("first", 0), email: null, plan: null } as const;
    await ops()(sealHandover(start.key, { codex, github: signIn, push: { keyId: "ABC123DEFG", pem } }));
    expect(await ops()({ op: "sign-ins" })).toEqual({ codex: "mac-login-1", github: signInPrint({ email: "fixture@example.com", name: null, token: GH_TOKEN }), push: "ABC123DEFG" });
  });

  it("sends its own phone alerts with the Mac's push key once handed it, and none once it is taken away", async () => {
    const pem = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    expect(await ops()(sealHandover(start.key, { push: { keyId: "ABC123DEFG", pem } }))).toEqual({ applied: ["push"] });
    expect(((await rpc("remote.status")) as { push: { keyId: string | null } }).push.keyId).toBe("ABC123DEFG");
    expect(await sealedBytes()).not.toContain("PRIVATE KEY");
    await ops()(sealHandover(start.key, { push: null }));
    expect(((await rpc("remote.status")) as { push: { keyId: string | null } }).push.keyId).toBeNull();
  });

  it("makes each handed-over Claude account under the Mac's id, with its name, token and the Mac's default", async () => {
    await ops()(
      sealHandover(start.key, {
        claude: {
          accounts: [
            { ...personal, default: false },
            { ...work, default: true },
          ],
        },
      }),
    );
    expect(claudeAccounts.list(core.db).map(({ id, name, enabled }) => ({ id, name, enabled }))).toEqual([
      { id: DEFAULT_CLAUDE_ACCOUNT, name: "Personal", enabled: true },
      { id: WORK, name: "Work", enabled: true },
    ]);
    expect(core.claudeAccounts.defaultId()).toBe(WORK);
    expect(await core.claudeCloudTokens.token(DEFAULT_CLAUDE_ACCOUNT)).toBe(TOKEN);
    expect(await core.claudeCloudTokens.token(WORK)).toBe(WORK_TOKEN);
    expect(core.claudeAccounts.environment(core.environment.current(), WORK).env["CLAUDE_CODE_OAUTH_TOKEN"]).toBe(WORK_TOKEN);
    const bytes = await sealedBytes();
    expect(bytes).not.toContain(TOKEN);
    expect(bytes).not.toContain(WORK_TOKEN);
  });

  it("signs out and disables an account the Mac no longer hands over, moving the default off it", async () => {
    await ops()(sealHandover(start.key, { claude: { accounts: [personal, work] } }));
    await ops()(sealHandover(start.key, { claude: { accounts: [{ ...work, name: "Client", default: true }] } }));
    expect(await core.claudeCloudTokens.token(DEFAULT_CLAUDE_ACCOUNT)).toBeNull();
    expect(claudeAccounts.get(core.db, DEFAULT_CLAUDE_ACCOUNT).enabled).toBe(false);
    expect(claudeAccounts.get(core.db, WORK)).toMatchObject({ name: "Client", enabled: true });
    expect(core.claudeAccounts.defaultId()).toBe(WORK);
    await ops()(sealHandover(start.key, { claude: { accounts: [] } }));
    expect(await core.claudeCloudTokens.token(WORK)).toBeNull();
    expect(claudeAccounts.get(core.db, WORK).enabled).toBe(true);
    expect(await (await SealedSecrets.open(layout.secrets, start.key)).store("claude-cloud").load()).toBe("{}");
  });

  it("disables, when the brain starts, an account left signed out while it was at work", async () => {
    await ops()(sealHandover(start.key, { claude: { accounts: [personal, work] } }));
    await core.claudeCloudTokens.remove(WORK);
    expect(claudeAccounts.get(core.db, WORK).enabled).toBe(true);
    await retireSignedOut(core);
    expect(claudeAccounts.get(core.db, WORK).enabled).toBe(false);
    expect(claudeAccounts.get(core.db, DEFAULT_CLAUDE_ACCOUNT).enabled).toBe(true);
  });

  describe("a Mac project's copy", () => {
    const SOURCE = "6f2b8c1e-0d4a-4f7b-9a53-2c8e1b7d4f90";
    const ORIGIN = "https://github.com/example/my-app.git";
    let mac: string;

    beforeEach(async () => {
      mac = path.join(root, "mac", "My App");
      await mkdir(mac, { recursive: true });
      await git(mac, ["init", "-q", "-b", "main"]);
      await git(mac, ["config", "user.email", "fixture@example.com"]);
      await git(mac, ["config", "user.name", "Fixture"]);
      await commitOn(mac, "README.md", "# Demo\n");
    });

    async function commitOn(folder: string, name: string, content: string): Promise<string> {
      await writeFile(path.join(folder, name), content);
      await commitAll(folder, `${name}: ${content.trim()}`);
      return (await git(folder, ["rev-parse", "HEAD"])).stdout.trim();
    }

    /** The Mac's main from `since`, uploaded to the inbox, then the op the Mac asks. */
    async function upload(since: string | null, project: { source?: string; name?: string } = {}) {
      const { bytes } = await bundleBranch(mac, "main", since);
      const bundle = `${randomUUID()}.bundle`;
      await mkdir(layout.inbox, { recursive: true });
      await writeFile(path.join(layout.inbox, bundle), bytes);
      return (await ops()({ op: "import-project", source: SOURCE, name: "My App", branch: "main", bundle, origin: ORIGIN, ...project })) as BrainControlResults["import-project"];
    }

    /** As `upload`, for a bundle the copy can take. */
    async function send(since: string | null, project: { source?: string; name?: string } = {}): Promise<ProjectCopy> {
      const taken = await upload(since, project);
      if ("lacksBase" in taken) throw new Error("the copy lacks the bundle's base");
      return taken;
    }

    it("is imported under the Mac project's id and name, fast-forwards from what is new, and takes a bundle again without change", async () => {
      const first = (await git(mac, ["rev-parse", "HEAD"])).stdout.trim();
      const imported = await send(null);
      expect(imported).toEqual({ projectId: expect.any(String), macHead: first, head: first });
      const project = core.projects.get(imported.projectId)!;
      expect(project).toMatchObject({ name: "My App", rootPath: path.join(layout.data, "projects", SOURCE, "My App"), gitRemote: ORIGIN, defaultBranch: "main" });
      expect(await readdir(layout.inbox)).toEqual([]);

      const second = await commitOn(mac, "b.txt", "b1\n");
      expect(await send(first)).toEqual({ ...imported, macHead: second, head: second });
      expect(await readFile(path.join(project.rootPath, "b.txt"), "utf8")).toBe("b1\n");
      expect(await send(first)).toEqual({ ...imported, macHead: second, head: second });
      expect(core.projects.list().map((listed) => listed.id)).toEqual([imported.projectId]);
      expect(await readdir(layout.inbox)).toEqual([]);

      const other = await send(null, { source: "another-mac-project" });
      expect(other.projectId).not.toBe(imported.projectId);
      expect(core.projects.get(other.projectId)?.name).toBe("My App");
      expect(await ops()({ op: "projects" })).toEqual({
        copies: expect.arrayContaining([
          { source: SOURCE, projectId: imported.projectId, macHead: second, head: second, threads: 0 },
          { source: "another-mac-project", projectId: other.projectId, macHead: second, head: second, threads: 0 },
        ]),
      });
    });

    it("takes the Mac project's setup script and other settings for its copy, and none for a project it has no copy of", async () => {
      const { projectId } = await send(null);
      const settings = { setupScript: "pnpm install", branchPrefix: "", worktreeInclude: [".env"] };
      expect(await ops()({ op: "project-settings", source: SOURCE, settings })).toEqual({ applied: true });
      expect(core.projects.get(projectId)?.settings).toMatchObject(settings);
      expect(await ops()({ op: "project-settings", source: "not-a-copy", settings })).toEqual({ applied: false });
    });

    it("keeps commits made on the brain's copy, saying so with its own head", async () => {
      const first = (await git(mac, ["rev-parse", "HEAD"])).stdout.trim();
      const { projectId } = await send(null);
      const copy = core.projects.get(projectId)!.rootPath;
      await git(copy, ["config", "user.email", "brain@example.com"]);
      await git(copy, ["config", "user.name", "Brain"]);
      const own = await commitOn(copy, "brain.txt", "made on the brain\n");
      const second = await commitOn(mac, "b.txt", "b1\n");
      expect(await send(first)).toEqual({ projectId, macHead: second, head: own });
      expect((await git(copy, ["rev-parse", "main"])).stdout.trim()).toBe(own);
      expect(await ops()({ op: "projects" })).toEqual({ copies: [{ source: SOURCE, projectId, macHead: second, head: own, threads: 0 }] });
    });

    it("says it lacks the commit a bundle builds on, taking nothing and leaving no upload behind", async () => {
      const first = (await git(mac, ["rev-parse", "HEAD"])).stdout.trim();
      await commitOn(mac, "b.txt", "b1\n");
      expect(await upload(first)).toEqual({ lacksBase: true });
      expect(core.projects.list()).toEqual([]);
      expect(await stat(path.join(layout.data, "projects", SOURCE, "My App")).catch(() => null)).toBeNull();
      expect(await readdir(layout.inbox)).toEqual([]);
    });

    it("counts a copy as synced when the Mac found it current, not when it took another commit of the Mac's since", async () => {
      const first = (await git(mac, ["rev-parse", "HEAD"])).stdout.trim();
      const { projectId } = await send(null);
      const copy = core.projects.get(projectId)!.rootPath;
      await writeFile(path.join(copy, ".git", "openorc-synced"), "1000");
      expect(
        await ops()({
          op: "copies-current",
          copies: [
            { source: SOURCE, macHead: first },
            { source: "no-such-copy", macHead: first },
          ],
        }),
      ).toEqual({ marked: 1 });
      expect(await copySyncedAt(copy)).toBeGreaterThan(Date.now() - 60_000);
      await commitOn(mac, "b.txt", "b1\n");
      await send(first);
      await writeFile(path.join(copy, ".git", "openorc-synced"), "1000");
      expect(await ops()({ op: "copies-current", copies: [{ source: SOURCE, macHead: first }] })).toEqual({ marked: 0 });
      expect(await copySyncedAt(copy)).toBe(1000);
    });

    it("is removed only while the brain has no thread in it, and removing it again changes nothing", async () => {
      const { projectId } = await send(null);
      const folder = path.join(layout.data, "projects", SOURCE);
      const thread = threads.insert(core.db, { projectId, title: "On the phone", agent: "claude", model: null, mode: "act", permissionMode: "trusted" });
      expect(await ops()({ op: "projects" })).toMatchObject({ copies: [{ source: SOURCE, threads: 1 }] });
      expect(await ops()({ op: "remove-project", source: SOURCE })).toEqual({ removed: false, threads: 1 });
      expect(core.projects.list().map((listed) => listed.id)).toEqual([projectId]);
      expect(await stat(folder).catch(() => null)).not.toBeNull();

      core.db.stmt("DELETE FROM threads WHERE id = ?").run(thread.id);
      expect(await ops()({ op: "remove-project", source: SOURCE })).toEqual({ removed: true, threads: 0 });
      expect(core.projects.list()).toEqual([]);
      expect(await stat(folder).catch(() => null)).toBeNull();
      expect(await ops()({ op: "projects" })).toEqual({ copies: [] });
      expect(await ops()({ op: "remove-project", source: SOURCE })).toEqual({ removed: true, threads: 0 });

      expect((await send(null)).projectId).toBe(projectId);
    });
  });

  it("answers stop before it closes the brain", async () => {
    expect(await ops()({ op: "stop" })).toEqual({ stopping: true });
    expect(stops).toBe(0);
    await new Promise((resolve) => setImmediate(resolve));
    expect(stops).toBe(1);
  });

  it("stops for an update only as the core's update check allows, which takes no new turn from then on", async () => {
    const refusal = "Wait for agent work, approvals, and context maintenance to finish before restarting to update.";
    vi.spyOn(core, "prepareForUpdate").mockReturnValueOnce(refusal);
    await expect(ops()({ op: "stop-for-update" })).rejects.toThrow(refusal);
    answering = true;
    await expect(ops()({ op: "stop-for-update" })).rejects.toThrow("answering another request");
    await new Promise((resolve) => setImmediate(resolve));
    expect(stops).toBe(0);
    answering = false;
    expect(await ops()({ op: "stop-for-update" })).toEqual({ stopping: true });
    expect(core.prepareForUpdate()).toBe(refusal);
    await new Promise((resolve) => setImmediate(resolve));
    expect(stops).toBe(1);
  });
});
