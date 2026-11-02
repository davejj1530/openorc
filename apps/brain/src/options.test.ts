import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { brainLayout, newBrainKey, type BrainStart } from "@openorc/cloud";
import { brainOptions } from "./options.js";
import { SealedSecrets } from "./secrets.js";

const connection = { token: "vercel-token-fixture", teamId: "team_fixture", projectId: "prj_brain" };

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "openorc-brain-options-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function options(vercel: BrainStart["vercel"]) {
  const layout = brainLayout(root);
  const start: BrainStart = { key: newBrainKey(), name: "Cloud", address: "sb-fixture.vercel.run", port: 47_820, vercel };
  const secrets = await SealedSecrets.open(layout.secrets, start.key);
  const runnerFiles = [{ name: "runner.ts", content: Buffer.from("export {};\n") }];
  return { layout, options: brainOptions({ layout, appDir: path.join(root, "app", "v1"), start, secrets, transport: { push() {} }, runnerFiles }), runnerFiles };
}

describe("brainOptions", () => {
  it("runs every conversation in the cloud, on the Vercel connection from the start, with no device tool", async () => {
    const { layout, options: brain, runnerFiles } = await options({ connection, sandbox: "brain" });
    expect(brain).toMatchObject({ dataDir: layout.data, cloudOnly: true, deviceSystem: null, cloudRunnerFiles: runnerFiles });
    expect(await brain.cloudCredentials?.()).toEqual(connection);
  });

  it("has no Vercel connection in a local container", async () => {
    expect(await (await options(null)).options.cloudCredentials?.()).toBeNull();
  });

  it("is reached only through the proxy at its public address, on the port the sandbox declared", async () => {
    const { remoteNetwork } = (await options(null)).options;
    expect(remoteNetwork).toMatchObject({ port: 47_820, publicAddress: "sb-fixture.vercel.run" });
    expect(remoteNetwork?.machine.name()).toBe("Cloud");
    expect(remoteNetwork?.machine.lanHosts()).toEqual([]);
    expect(await remoteNetwork?.machine.tailnetHosts()).toEqual([]);
  });

  it("keeps its sealed stores and none for Slack or the Vercel connection", async () => {
    const brain = (await options(null)).options;
    for (const option of ["remoteSecrets", "pushSecrets", "claudeCloudSecrets", "codexCloudSecrets", "memorySecrets", "githubSecrets"] as const) expect(brain[option]).toBeDefined();
    expect(brain.slackSecrets).toBeUndefined();
    expect(brain.cloudSecrets).toBeUndefined();
  });

  it("offers nothing a Mac's windows would: no browser, preview, presence, terminal, formatter or place to choose", async () => {
    const brain = (await options(null)).options;
    for (const option of ["browser", "preview", "presence", "terminal", "formatter", "cloudOffered", "fileKey", "benchmarks"] as const) expect(brain[option]).toBeUndefined();
  });

  it("finds agent CLIs where machine setup installed them, ahead of the system's, without a login shell", async () => {
    const { layout, options: brain } = await options(null);
    const bin = path.join(layout.npm, "bin");
    await mkdir(bin, { recursive: true });
    await writeFile(path.join(bin, "claude"), "#!/bin/sh\n", { mode: 0o755 });
    const probed = await brain.shellProbe!("/bin/does-not-exist");
    expect(probed.path.split(":").slice(0, 2)).toEqual([bin, path.dirname(process.execPath)]);
    expect(probed.binaries.claude).toBe(path.join(bin, "claude"));
  });
});
