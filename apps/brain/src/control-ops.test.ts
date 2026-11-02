import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { brainKeyText, brainLayout, newBrainKey, sealHandover, type BrainLayout, type BrainStart } from "@openorc/cloud";
import { OpenOrc } from "@openorc/core";
import { DEFAULT_CLAUDE_ACCOUNT } from "@openorc/protocol";
import { claudeAccounts } from "@openorc/db";
import { commitAll, git } from "@openorc/git";
import { NO_SANDBOX } from "./awake.js";
import { controlHandlers, retireSignedOut } from "./control-ops.js";
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

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "openorc-brain-ops-")));
  layout = brainLayout(root);
  start = { key: newBrainKey(), name: "Cloud", address: "localhost", port: 0, vercel: null };
  const secrets = await SealedSecrets.open(layout.secrets, start.key);
  core = await OpenOrc.create({ ...brainOptions({ layout, appDir: path.join(root, "app", "v1"), start, self: NO_SANDBOX, secrets, transport: { push() {} }, runnerFiles: [] }), ephemeral: true });
  stops = 0;
  answering = false;
});

afterEach(async () => {
  await core.close();
  await rm(root, { recursive: true, force: true });
});

const ops = () => controlHandlers({ core, key: start.key, layout, stop: () => stops++, answering: () => answering });

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

  it("refuses a Codex login before applying anything else in the same handover", async () => {
    await expect(ops()(sealHandover(start.key, { claude: { accounts: [personal] }, codex: { auth: "{}" } }))).rejects.toThrow("does not take a codex sign-in yet");
    expect(core.claudeCloudTokens.known(DEFAULT_CLAUDE_ACCOUNT)).toBeNull();
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

  it("imports a project from a git bundle in the inbox, with the origin it was given", async () => {
    const source = path.join(root, "source");
    await mkdir(source);
    await git(source, ["init", "-q", "-b", "main"]);
    await git(source, ["config", "user.email", "fixture@example.com"]);
    await git(source, ["config", "user.name", "Fixture"]);
    await writeFile(path.join(source, "README.md"), "# Demo\n");
    await commitAll(source, "Fixture baseline");
    await mkdir(layout.inbox, { recursive: true });
    await git(source, ["bundle", "create", path.join(layout.inbox, "demo.bundle"), "--all"]);
    const imported = (await ops()({ op: "import-project", name: "demo", bundle: "demo.bundle", origin: "https://github.com/example/demo.git" })) as { projectId: string };
    const project = core.projects.list().find((candidate) => candidate.id === imported.projectId);
    expect(project?.rootPath).toBe(path.join(layout.data, "projects", "demo"));
    expect((await git(project!.rootPath, ["remote", "get-url", "origin"])).stdout.trim()).toBe("https://github.com/example/demo.git");
    expect(await readdir(layout.inbox)).toEqual([]);
    await expect(ops()({ op: "import-project", name: "demo", bundle: "demo.bundle" })).rejects.toThrow("already has a project named demo");
    await expect(ops()({ op: "import-project", name: "..", bundle: "demo.bundle" })).rejects.toThrow("letters, digits");
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
