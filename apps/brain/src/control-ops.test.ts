import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { brainKeyText, brainLayout, newBrainKey, sealHandover, type BrainLayout, type BrainStart } from "@openorc/cloud";
import { OpenOrc } from "@openorc/core";
import { DEFAULT_CLAUDE_ACCOUNT } from "@openorc/protocol";
import { commitAll, git } from "@openorc/git";
import { controlHandlers } from "./control-ops.js";
import { brainOptions } from "./options.js";
import { SealedSecrets } from "./secrets.js";

const TOKEN = "sk-ant-oat01-handed-over-fixture-token";

let root: string;
let layout: BrainLayout;
let start: BrainStart;
let core: OpenOrc;
let stops = 0;

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "openorc-brain-ops-")));
  layout = brainLayout(root);
  start = { key: newBrainKey(), name: "Cloud", address: "localhost", port: 0, vercel: null };
  const secrets = await SealedSecrets.open(layout.secrets, start.key);
  core = await OpenOrc.create({ ...brainOptions({ layout, appDir: path.join(root, "app", "v1"), start, secrets, transport: { push() {} }, runnerFiles: [] }), ephemeral: true });
  stops = 0;
});

afterEach(async () => {
  await core.close();
  await rm(root, { recursive: true, force: true });
});

const ops = () => controlHandlers({ core, key: start.key, layout, stop: () => stops++ });

async function sealedBytes(): Promise<string> {
  const names = await readdir(layout.secrets);
  return (await Promise.all(names.map((name) => readFile(path.join(layout.secrets, name), "latin1")))).join("\n");
}

describe("control requests on the brain's core", () => {
  it("keeps a handed-over Claude token sealed, and the core signs in with it", async () => {
    expect(await ops()(sealHandover(start.key, { claude: { token: TOKEN } }))).toEqual({ applied: ["claude"] });
    expect(core.claudeCloudTokens.known(DEFAULT_CLAUDE_ACCOUNT)).toBe(TOKEN);
    const bytes = await sealedBytes();
    expect(bytes).not.toContain(TOKEN);
    expect(bytes).not.toContain(brainKeyText(start.key));
    expect(await (await SealedSecrets.open(layout.secrets, start.key)).store("claude-cloud").load()).toContain(TOKEN);
  });

  it("refuses a handover sealed under another key, applying nothing", async () => {
    await expect(ops()(sealHandover(newBrainKey(), { claude: { token: TOKEN } }))).rejects.toThrow("does not open with this brain key");
    expect(core.claudeCloudTokens.known(DEFAULT_CLAUDE_ACCOUNT)).toBeNull();
  });

  it("refuses a Codex login before applying anything else in the same handover", async () => {
    await expect(ops()(sealHandover(start.key, { claude: { token: TOKEN }, codex: { auth: "{}" } }))).rejects.toThrow("does not take a codex sign-in yet");
    expect(core.claudeCloudTokens.known(DEFAULT_CLAUDE_ACCOUNT)).toBeNull();
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
});
