import { projects, tasks, threads } from "@openorc/db";
import { standIn, type StandIn } from "@openorc/hosted/testing";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { OpenOrc } from "../openorc.js";
import { rpcClient } from "../rpc-test-client.js";

const EMAIL = "admin@example.com";
let stand: StandIn;
let folder: string;
let core: OpenOrc;
const call = rpcClient(() => core);

beforeEach(async () => {
  stand = await standIn({ signup: "open" });
  folder = await mkdtemp(path.join(tmpdir(), "openorc-scoped-"));
  let token: string | null = null;
  core = await OpenOrc.create({
    dataDir: path.join(folder, "data"),
    transport: { push() {} },
    accountServer: stand.url,
    accountSecrets: {
      load: async () => token,
      save: async (value) => {
        token = value;
      },
    },
    openBrowser: (url) => {
      if (new URL(url).pathname === "/sign-in") void fetch(stand.signInPage(url, EMAIL));
    },
    shellProbe: async () => ({
      path: process.env["PATH"] ?? "",
      binaries: {
        claude: "/usr/bin/false",
        codex: "/usr/bin/false",
        opencode: "/usr/bin/false",
        omp: "/usr/bin/false",
        cursor: "/usr/bin/false",
        pi: "/usr/bin/false",
        antigravity: "/usr/bin/false",
        fx: "/usr/bin/false",
      },
    }),
  });
});
afterEach(async () => {
  await core?.close();
  await stand?.close();
  await rm(folder, { recursive: true, force: true });
});

function local(name: string, remote: string | null) {
  const project = projects.insert(core.db, { name, rootPath: path.join(folder, name), gitRemote: remote, defaultBranch: null, settings: {} });
  const thread = threads.insert(core.db, { projectId: project.id, title: name, agent: "codex", model: null, mode: "act", permissionMode: "trusted" });
  return { project, thread };
}
async function signIn() {
  await call("account.signIn", {});
  await vi.waitFor(async () => expect(await call("spaces.status", {})).toMatchObject({ state: "ready" }));
}

it("projects local work before pagination even when the organization has no cloud rows", async () => {
  const team = stand.addTeam("Birch Studio", [EMAIL]);
  stand.addProject(EMAIL, { name: "Canvas", fullName: "example/canvas" }, team);
  const a = local("Canvas", "git@github.com:example/canvas.git");
  const b = local("Notes", null);
  await signIn();
  expect((await call("threads.list", { spaceId: team, limit: 1 })).map((row) => row.id)).toEqual([a.thread.id]);
  expect(await call("threads.list", { spaceId: team, limit: 1, offset: 1 })).toEqual([]);
  expect((await call("threads.list", { spaceId: `personal-${EMAIL}` })).map((row) => row.id)).toEqual([b.thread.id]);
  expect(await call("threads.resolvedCount", { spaceId: team, projectIds: [a.project.id, b.project.id], quietBefore: Date.now() + 60_000 })).toBe(1);
  expect((await call("threads.list", {})).map((row) => row.id)).toEqual(expect.arrayContaining([a.thread.id, b.thread.id]));
});

it("merges duplicate local copies once each with own and teammate cloud rows, keeping personal cloud under its own key", async () => {
  const team = stand.addTeam("Birch Studio", [EMAIL, "member@example.com"]);
  const teamProject = stand.addProject(EMAIL, { name: "Canvas", fullName: "example/canvas" }, team);
  const personalProject = stand.addProject(EMAIL, { name: "Canvas", fullName: "example/canvas" });
  const own = stand.addThread(EMAIL, { projectId: teamProject, title: "Own cloud" });
  const other = stand.addThread("member@example.com", { projectId: teamProject, title: "Team cloud", status: "needs_answer" });
  const personal = stand.addThread(EMAIL, { projectId: personalProject, title: "Personal cloud" });
  const a = local("First", "https://github.com/example/canvas.git");
  const b = local("Second", "git@github.com:example/canvas");
  await signIn();
  await vi.waitFor(async () => expect(await call("threads.list", { spaceId: team })).toHaveLength(4));
  const first = await call("threads.list", { spaceId: team, limit: 2 });
  const second = await call("threads.list", { spaceId: team, limit: 2, offset: 2 });
  expect(new Set([...first, ...second].map((row) => row.id))).toEqual(new Set([a.thread.id, b.thread.id, own, other]));
  expect((await call("threads.list", { spaceId: team, ownership: "mine" })).map((row) => row.id)).toEqual(expect.arrayContaining([a.thread.id, b.thread.id, own]));
  expect(await call("threads.list", { spaceId: team, ownership: "mine" })).toHaveLength(3);
  expect(await call("threads.list", { spaceId: `personal-${EMAIL}` })).toMatchObject([{ id: personal, projectId: `openorc-cloud:${personalProject}` }]);
  const presentations = await call("spaces.projects", { spaceId: team });
  const [primary, secondary] = presentations;
  expect(await call("threads.list", { spaceId: team, projectIds: [primary!.key] })).toHaveLength(3);
  expect(await call("threads.list", { spaceId: team, projectIds: [secondary!.key] })).toHaveLength(1);
});

it("filters tasks and refuses local starts outside the chosen space", async () => {
  const team = stand.addTeam("Birch Studio", [EMAIL]);
  stand.addProject(EMAIL, { name: "Canvas", fullName: "example/canvas" }, team);
  const a = local("Canvas", "git@github.com:example/canvas.git");
  const b = local("Notes", null);
  for (const project of [a.project, b.project])
    tasks.insert(core.db, { projectId: project.id, title: project.name, spec: null, priority: "none", labels: [], workspaceMode: "worktree", baseRef: null, parentTaskId: null });
  await signIn();
  expect(await call("tasks.list", { spaceId: team })).toMatchObject([{ projectId: a.project.id }]);
  expect(await call("tasks.list", { spaceId: team, projectId: b.project.id })).toEqual([]);
  await expect(call("threads.start", { spaceId: team, projectId: b.project.id, agent: "codex", mode: "act", permissionMode: "trusted", prompt: "Go" })).rejects.toThrow(
    "This project isn't available in this space.",
  );
});

it("searches visible folders before applying a limit", async () => {
  const team = stand.addTeam("Birch Studio", [EMAIL]);
  stand.addProject(EMAIL, { name: "Canvas", fullName: "example/canvas" }, team);
  const a = local("Canvas", "git@github.com:example/canvas.git");
  const b = local("Notes", null);
  for (const [index, item] of [a, b].entries()) {
    const runId = `search-${index}`;
    core.db.stmt("INSERT INTO runs (id, thread_id, agent, mode, permission_mode, state, started_at) VALUES (?, ?, 'codex', 'act', 'trusted', 'success', ?)").run(runId, item.thread.id, Date.now());
    core.ledger.push({ type: "message.completed", runId, ts: Date.now() + index, messageId: runId, role: "assistant", text: "Searchable project note." });
  }
  core.ledger.flush();
  await signIn();
  expect((await call("threads.search", { spaceId: team, query: "searchable", limit: 1 })).map((hit) => hit.threadId)).toEqual([a.thread.id]);
  expect(await call("threads.search", { spaceId: team, query: "searchable", projectId: b.project.id })).toEqual([]);
  expect((await call("threads.search", { spaceId: `personal-${EMAIL}`, query: "searchable", limit: 1 })).map((hit) => hit.threadId)).toEqual([b.thread.id]);
});

it("starts on the exact space and accepts a cloud-only project without a local folder", async () => {
  const a = stand.addTeam("Birch Studio", [EMAIL]);
  const b = stand.addTeam("Cedar Studio", [EMAIL]);
  const projectA = stand.addProject(EMAIL, { name: "Canvas", fullName: "example/canvas" }, a);
  stand.addProject(EMAIL, { name: "Canvas", fullName: "example/canvas" }, b);
  stand.addProject(EMAIL, { name: "Canvas", fullName: "example/canvas" });
  const only = stand.addProject(EMAIL, { name: "Tools", fullName: "example/tools" }, b);
  const paired = local("Canvas", "git@github.com:example/canvas.git");
  stand.setBilling(EMAIL, { pro: true, standing: "live", at: new Date(Date.now() + 86_400_000).toISOString(), monthlyLeftSeconds: 1000, packsLeftSeconds: 0 });
  stand.setSignIns(EMAIL, [{ agent: "codex" }]);
  await signIn();
  await vi.waitFor(async () => expect(await call("account.status", {})).toMatchObject({ projects: [{ cloud: "added" }] }));
  const input = { agent: "codex", mode: "act", permissionMode: "trusted", prompt: "Go", hosted: true } as const;
  const first = await call("threads.start", { ...input, spaceId: b, projectId: paired.project.id });
  expect(first.thread.projectId).toBe(paired.project.id);
  expect((await call("threads.list", { spaceId: b })).some((row) => row.id === first.thread.id)).toBe(true);
  expect((await call("threads.list", { spaceId: a })).some((row) => row.id === first.thread.id)).toBe(false);
  const cloudOnly = await call("threads.start", { ...input, spaceId: b, projectId: `openorc-cloud:${only}` });
  expect(cloudOnly.thread.projectId).toBe(`openorc-cloud:${only}`);
  await expect(call("threads.start", { ...input, spaceId: b, projectId: `openorc-cloud:${projectA}` })).rejects.toThrow("This project isn't available in this space.");
});
