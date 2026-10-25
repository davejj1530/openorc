import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { orchestration, projects, threads } from "@openorc/db";
import * as gitTools from "@openorc/git";
import type { Project, Thread } from "@openorc/protocol";
import { OpenOrc } from "../openorc.js";
import type { ProtectedSecretStore } from "../services/extraction-credentials.js";
import { RemoteTestClient } from "./test-client.js";

const { commitAll, git } = gitTools;
const TOKEN = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij12";
const machine = { name: () => "Test Mac", lanHosts: () => ["127.0.0.1"], tailnetHosts: async () => [] };

function memorySecrets(): ProtectedSecretStore {
  let value: string | null = null;
  return {
    load: async () => value,
    save: async (next) => {
      value = next;
    },
  };
}

let folder: string;
let root: string;
let bare: string;
let core: OpenOrc;
let project: Project;
let phone: RemoteTestClient;

async function worktreeThread(title: string): Promise<Thread & { worktreePath: string }> {
  const thread = threads.insert(core.db, { projectId: project.id, title, agent: "codex", model: null, mode: "act", permissionMode: "trusted", workspaceMode: "worktree" });
  const baseSha = (await git(root, ["rev-parse", "HEAD"])).stdout.trim();
  const worktreePath = path.join(folder, title.toLowerCase().replace(/\W+/g, "-"));
  const branch = `feat/${path.basename(worktreePath)}`;
  await git(root, ["worktree", "add", "-q", "-b", branch, worktreePath]);
  return { ...threads.update(core.db, thread.id, { baseSha, worktreePath, branch }), worktreePath };
}

/** The audit rows the ledger kept for an action, metadata parsed. */
const auditRows = (action: string) =>
  (core.db.stmt("SELECT actor, metadata FROM audit_events WHERE action = ? ORDER BY id").all(action) as Array<{ actor: string; metadata: string }>).map((row) => ({
    actor: row.actor,
    metadata: JSON.parse(row.metadata) as Record<string, unknown>,
  }));

beforeAll(async () => {
  folder = await mkdtemp(path.join(os.tmpdir(), "openorc-phone-git-"));
  root = path.join(folder, "repo");
  bare = path.join(folder, "remote.git");
  await mkdir(root);
  await git(root, ["init", "-q", "-b", "main"]);
  await git(root, ["config", "user.email", "fixture@example.com"]);
  await git(root, ["config", "user.name", "Fixture"]);
  await writeFile(path.join(root, "README.md"), "# Phone\n");
  await commitAll(root, "Initial commit");
  await git(folder, ["init", "-q", "--bare", bare]);
  await git(root, ["remote", "add", "origin", "https://github.com/fake/phone.git"]);
  await git(root, ["config", "remote.origin.pushurl", bare]);
  await git(root, ["push", "-q", "-u", "origin", "main"]);
  core = await OpenOrc.create({ dataDir: path.join(folder, "data"), ephemeral: true, transport: { push: () => {} }, remoteSecrets: memorySecrets(), remoteNetwork: { port: 0, machine } });
  await core.remote.attach((request, origin) => core.handle(request, origin));
  await core.remote.configure(true);
  project = projects.insert(core.db, { name: "Phone", rootPath: root, defaultBranch: "main", gitRemote: "https://github.com/fake/phone.git", settings: {} });
  const paired = await RemoteTestClient.pair((await core.remote.beginPairing()).url);
  if (typeof paired === "string") throw new Error(`refused: ${paired}`);
  phone = paired;
});

afterAll(async () => {
  phone?.close();
  await core?.close();
  vi.restoreAllMocks();
  if (folder) await rm(folder, { recursive: true, force: true });
});

describe("a phone publishing a thread's work", () => {
  it("reads the changes and one file's diff, with a planted token redacted", async () => {
    const thread = await worktreeThread("Reads");
    await writeFile(path.join(thread.worktreePath, "config.ts"), `export const token = "${TOKEN}";\n`);
    const changes = await phone.call("review.threadChanges", { threadId: thread.id, comparison: "head" });
    expect(changes).toMatchObject({ comparison: "head", totals: { files: 1, insertions: 1, deletions: 0 }, files: [{ path: "config.ts", status: "untracked" }] });
    const diff = await phone.call("review.threadFileDiff", { threadId: thread.id, comparison: "head", path: changes.files[0]!.path as never });
    expect(diff.patch).toBe('@@ -0,0 +1 @@\n+export const token = "[redacted:github-token]";\n');
    expect(await phone.call("system.gh", {})).toEqual({ installed: expect.any(Boolean) });
  });

  it("commits, pushes into the bare repo and opens a pull request, each audited as the user on this phone", async () => {
    const thread = await worktreeThread("Publish");
    await writeFile(path.join(thread.worktreePath, "feature.ts"), "export const on = true;\n");
    const { sha } = await phone.call("review.commitThread", { threadId: thread.id, message: "Add the feature" });
    expect(await phone.call("git.threadLog", { threadId: thread.id, limit: 1 })).toEqual([expect.objectContaining({ sha, subject: "Add the feature" })]);
    expect(await phone.call("git.threadPushState", { threadId: thread.id })).toMatchObject({ branch: thread.branch, published: false });
    expect(await phone.call("review.pushThread", { threadId: thread.id })).toEqual({ remote: "origin", branch: thread.branch });
    expect((await git(folder, ["--git-dir", bare, "rev-parse", `refs/heads/${thread.branch}`])).stdout.trim()).toBe(sha);

    vi.spyOn(gitTools, "hasGh").mockResolvedValue(true);
    const created = vi.spyOn(gitTools, "createPr").mockResolvedValue("https://github.com/fake/phone/pull/7");
    expect(await phone.call("review.createThreadPr", { threadId: thread.id, title: "Add the feature", body: "Check it", base: "main" })).toEqual({ url: "https://github.com/fake/phone/pull/7" });
    expect(created).toHaveBeenCalledWith(expect.any(String), { title: "Add the feature", body: "Check it", base: "main", head: thread.branch });

    const via = { via: "phone", device: phone.deviceId };
    expect(auditRows("thread.commit").at(-1)).toEqual({ actor: "user", metadata: { sha, ...via } });
    expect(auditRows("thread.push").at(-1)).toEqual({ actor: "user", metadata: { branch: thread.branch, ...via } });
    expect(auditRows("thread.pr").at(-1)).toEqual({ actor: "user", metadata: { url: "https://github.com/fake/phone/pull/7", ...via } });
  });

  it("redacts a token a failing hook prints", async () => {
    const thread = await worktreeThread("Hook");
    const hook = path.join(root, ".git", "hooks", "pre-commit");
    await mkdir(path.dirname(hook), { recursive: true });
    await writeFile(hook, `#!/bin/sh\necho "lint failed: ${TOKEN}" >&2\nexit 1\n`);
    await chmod(hook, 0o755);
    try {
      await writeFile(path.join(thread.worktreePath, "hooked.ts"), "export const hooked = 1;\n");
      const refusal = await phone.call("review.commitThread", { threadId: thread.id, message: "Hooked" }).catch((error: Error) => error.message);
      expect(refusal).toContain("lint failed: [redacted:github-token]");
      expect(refusal).not.toContain(TOKEN);
    } finally {
      await rm(hook);
    }
  });

  it("leaves a team's publishing to the Mac, and keeps the whole patch and the Mac's paths", async () => {
    const thread = await worktreeThread("Team");
    const instance = vi.spyOn(orchestration, "getInstance").mockImplementation(((_db: unknown, id: string) => (id === thread.id ? ({ id: "instance" } as never) : null)) as never);
    try {
      await expect(phone.call("review.commitThread", { threadId: thread.id, message: "Team work" })).rejects.toThrow("Publish a team's work on your Mac.");
      await expect(phone.call("review.pushThread", { threadId: thread.id })).rejects.toThrow("Publish a team's work on your Mac.");
    } finally {
      instance.mockRestore();
    }
    await expect(phone.call("review.threadDiff", { threadId: thread.id })).rejects.toThrow("This is not available from a phone.");
    await expect(phone.call("system.info", {})).rejects.toThrow("This is not available from a phone.");
  });

  it("audits a window's commit without a phone", async () => {
    const thread = await worktreeThread("Window");
    await writeFile(path.join(thread.worktreePath, "window.ts"), "export const window = 1;\n");
    const reply = await core.handle({ type: "rpc", id: 1, method: "review.commitThread", params: { threadId: thread.id, message: "From the Mac" } });
    expect(reply.type).toBe("rpc.result");
    expect(auditRows("thread.commit").at(-1)!.metadata).not.toHaveProperty("via");
  });
});
