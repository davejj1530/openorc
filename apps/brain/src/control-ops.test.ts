import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { brainKeyText, brainLayout, bundleBranch, newBrainKey, sealHandover, type BrainControlResults, type BrainLayout, type BrainStart, type ProjectCopy } from "@openorc/cloud";
import { OpenOrc } from "@openorc/core";
import { DEFAULT_CLAUDE_ACCOUNT } from "@openorc/protocol";
import { claudeAccounts, threads } from "@openorc/db";
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
