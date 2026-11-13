import { projects, threads } from "@openorc/db";
import { standIn, type StandIn } from "@openorc/hosted/testing";
import type { ThreadSummary } from "@openorc/protocol";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenOrc } from "../openorc.js";
import { rpcClient } from "../rpc-test-client.js";
import type { ProtectedSecretStore } from "./extraction-credentials.js";

const EMAIL = "ada@example.com";

let stand: StandIn;
let folder: string;
let stored: string | null;
let core: OpenOrc | null = null;
const call = rpcClient(() => core!);
const accountSecrets: ProtectedSecretStore = { load: async () => stored, save: async (value) => void (stored = value) };

beforeEach(async () => {
  stand = await standIn({ signup: "open" });
  folder = await mkdtemp(path.join(tmpdir(), "openorc-places-"));
  stored = null;
});

afterEach(async () => {
  await core?.close();
  core = null;
  await stand.close();
  await rm(folder, { recursive: true, force: true });
});

async function open(options: { accountServer?: string } = { accountServer: stand.url }) {
  core = await OpenOrc.create({ dataDir: path.join(folder, "data"), transport: { push() {} }, accountSecrets, ...options });
  return core;
}

/** This Mac's project for the repository, made once per profile, with one thread of its own. */
function macProject(opened: OpenOrc) {
  const project =
    projects.list(opened.db).find((each) => each.name === "openorc") ??
    projects.insert(opened.db, { name: "openorc", rootPath: folder, gitRemote: "https://github.com/altalogy/openorc.git", defaultBranch: "main", settings: {} });
  if (!threads.list(opened.db, { projectId: project.id }).length)
    threads.insert(opened.db, { projectId: project.id, title: "On this Mac", agent: "codex", model: null, mode: "act", permissionMode: "trusted" });
  return project;
}

async function signIn() {
  await call("account.sendCode", { email: EMAIL });
  await call("account.signIn", { email: EMAIL, code: stand.codeFor(EMAIL)! });
}

const list = (projectIds: string[]) => call("threads.list", { projectIds, filter: "active", includeChildren: true });

describe("OpenOrc Cloud threads in the window's calls", () => {
  it("lists them beside this Mac's, under the Mac project with their repository, and answers them by id", async () => {
    const opened = await open();
    const project = macProject(opened);
    const cloudProject = stand.addProject(EMAIL, { name: "openorc", fullName: "Altalogy/openorc" });
    const hosted = stand.addThread(EMAIL, { projectId: cloudProject, title: "Retry the cloud start", status: "working" });
    stand.append(hosted, [{ type: "turn.started" }]);
    await signIn();
    await vi.waitFor(async () => expect((await list([project.id])).map((row) => row.title)).toEqual(expect.arrayContaining(["On this Mac", "Retry the cloud start"])), { timeout: 5_000 });
    const rows = await list([project.id]);
    expect(rows.find((row) => row.id === hosted)).toMatchObject({ projectId: project.id, activity: "running", owner: { brain: "hosted", reach: "live" } });
    expect(rows.find((row) => row.title === "On this Mac")?.owner).toBeUndefined();
    expect(await call("threads.get", { id: hosted })).toMatchObject({ id: hosted, title: "Retry the cloud start" });
    expect(await call("runs.listForThread", { threadId: hosted })).toMatchObject([{ id: `hosted:${hosted}`, state: "running" }]);
    await expect(call("threads.fork", { id: hosted })).rejects.toThrow("This isn't on OpenOrc Cloud yet.");
  });

  it("keeps them through a restart while the server is down, and lets them go on sign-out", async () => {
    let opened = await open();
    const project = macProject(opened);
    const cloudProject = stand.addProject(EMAIL, { name: "openorc", fullName: "altalogy/openorc" });
    const hosted = stand.addThread(EMAIL, { projectId: cloudProject, title: "Kept" });
    await signIn();
    await vi.waitFor(async () => expect((await list([project.id])).some((row) => row.id === hosted)).toBe(true), { timeout: 5_000 });
    await opened.close();
    await stand.down();
    opened = await open();
    await vi.waitFor(async () => expect((await list([project.id])).find((row) => row.id === hosted)?.owner).toMatchObject({ brain: "hosted", reach: "offline" }));
    await call("account.signOut", {});
    expect((await list([project.id])).map((row: ThreadSummary) => row.title)).toEqual(["On this Mac"]);
  });

  it("answers every call as before, and asks no server, with nobody signed in", async () => {
    const opened = await open();
    const project = macProject(opened);
    expect((await list([project.id])).map((row) => row.title)).toEqual(["On this Mac"]);
    await expect(call("threads.get", { id: "not-a-thread" })).resolves.toBeNull();
    expect(stand.requests).toEqual([]);
  });
});
