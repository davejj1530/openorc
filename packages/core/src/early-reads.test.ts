import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Db, projects } from "@openorc/db";
import { afterEach, describe, expect, it } from "vitest";
import { answeredEarly } from "./early-reads.js";
import { OpenOrc } from "./openorc.js";
import type { ShellProbeResult } from "./services/shell-environment.js";

const none = { claude: null, codex: null, opencode: null, omp: null, cursor: null, pi: null, antigravity: null, fx: null };
const roots: string[] = [];
const cores: OpenOrc[] = [];
afterEach(async () => {
  for (const core of cores.splice(0)) await core.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A core whose login shell answers only when `answer` is called, as a slow profile does. */
async function opened() {
  const root = mkdtempSync(path.join(os.tmpdir(), "openorc-early-reads-"));
  roots.push(root);
  let answer: (result: ShellProbeResult) => void = () => {};
  const shell = new Promise<ShellProbeResult>((resolve) => (answer = resolve));
  const core = await OpenOrc.open({ dataDir: path.join(root, "data"), ephemeral: true, transport: { push: () => {} }, shellProbe: () => shell });
  cores.push(core);
  return { core, answer: () => answer({ path: process.env["PATH"] ?? "", binaries: none }) };
}

const settled = (promise: Promise<unknown>) => Promise.race([promise.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 300))]);

describe("a start before the login shell has answered", () => {
  it("answers reads of this Mac's ledger at once", async () => {
    const { core, answer } = await opened();
    expect(await settled(core.handle({ type: "rpc", id: 1, method: "threads.list", params: {} }))).toBe(true);
    expect(await settled(core.handle({ type: "rpc", id: 2, method: "projects.list", params: {} }))).toBe(true);
    answer();
    await core.started;
  });

  it("holds what launches, what the account answers and a thread this Mac doesn't hold until the shell has answered", async () => {
    const { core, answer } = await opened();
    const held = [
      core.handle({ type: "rpc", id: 1, method: "runs.start", params: { threadId: "t", agent: "claude", mode: "act", permissionMode: "autonomous", prompt: "hello" } }),
      core.handle({ type: "rpc", id: 2, method: "account.status", params: {} }),
      core.handle({ type: "rpc", id: 3, method: "threads.get", params: { id: "a-cloud-thread" } }),
    ];
    for (const call of held) expect(await settled(call)).toBe(false);
    expect(core.environment.current().revision, "nothing ran on the launcher's environment").toBe(0);
    answer();
    await core.started;
    for (const call of held) expect(await settled(call)).toBe(true);
    expect(core.environment.current().revision).toBe(1);
  });
});

describe("which calls a start answers before the login shell", () => {
  it("is the ledger's reads of what this Mac holds, and nothing that launches or that the account answers", () => {
    const db = Db.memory();
    const project = projects.insert(db, { name: "repo", rootPath: "/tmp/repo", gitRemote: null, defaultBranch: "main", settings: {} });
    const early = (method: string, params: unknown = {}) => answeredEarly(db, { type: "rpc", id: 1, method, params } as never);
    expect(early("threads.list")).toBe(true);
    expect(early("projects.get", { id: project.id }), "a project of this Mac").toBe(true);
    expect(early("projects.get", { id: "openorc-cloud:elsewhere" }), "a project only the cloud has").toBe(false);
    expect(early("threads.get", { id: "a-cloud-thread" })).toBe(false);
    for (const method of ["runs.start", "threads.start", "terminal.open", "account.status", "spaces.status", "system.info", "agents.models"]) expect(early(method), method).toBe(false);
  });
});
