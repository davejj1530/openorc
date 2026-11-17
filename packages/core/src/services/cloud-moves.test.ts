import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { claudeSessionFile, hostHome, packSession, unpackSession, type SessionId } from "@openorc/agents";
import { cloudMoves, Db, LedgerWriter, listEvents, projects, runs, threads } from "@openorc/db";
import type { ArrivalLine, Hosted } from "@openorc/hosted";
import { computerNames, type AgentEvent } from "@openorc/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSessions, type AgentHomes } from "./agent-sessions.js";
import { CloudMoves } from "./cloud-moves.js";
import { WorkspaceService } from "./workspace.js";

const SESSION = "0b9f3c3e-5d2a-4f1e-9c47-2a6f0d8e1b55" as SessionId;
const quiet = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: os.devNull,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "A",
  GIT_AUTHOR_EMAIL: "a@example.com",
  GIT_COMMITTER_NAME: "A",
  GIT_COMMITTER_EMAIL: "a@example.com",
};
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();

let root: string;
let db: Db;
let ledger: LedgerWriter;
let folder: string;
let claude: string;
let cli: string;
let workspaces: WorkspaceService;

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "openorc-cloud-moves-")));
  // The project: a clone of "GitHub", so GitHub's copy of its base branch is here.
  const github = path.join(root, "github.git");
  git(root, "init", "-q", "--bare", "-b", "main", github);
  const seed = path.join(root, "seed");
  git(root, "clone", "-q", github, seed);
  await writeFile(path.join(seed, "README.md"), "first\n");
  git(seed, "add", "-A");
  git(seed, "commit", "-q", "-m", "First");
  git(seed, "push", "-q", "origin", "HEAD:main");
  folder = path.join(root, "app");
  git(root, "clone", "-q", github, folder);
  claude = path.join(root, "claude");
  cli = path.join(root, "cli");
  await writeFile(cli, `#!/bin/sh\necho "2.1.317 (stand-in)"\n`);
  await chmod(cli, 0o755);
  db = Db.memory();
  ledger = new LedgerWriter(db);
  workspaces = new WorkspaceService(db, { dataDir: path.join(root, "data") }, quiet as never);
});

afterEach(async () => {
  db.close();
  await rm(root, { recursive: true, force: true });
});

const homes: AgentHomes = { here: () => hostHome({ agent: "claude", userHome: root, env: { CLAUDE_CONFIG_DIR: claude }, binary: cli, processEnv: {} }) };

/** The account as far as moves go: a Personal space, a cloud project for the folder, its threads, and what was sent. */
function account() {
  const sent = {
    arrived: [] as { space: string; id: string; projectId: string }[],
    history: [] as ArrivalLine[],
    session: null as null | { query: { agent: string; sessionId: string; cliVersion: string }; packed: Uint8Array },
    work: null as null | { query: Record<string, string>; bytes: number },
    done: [] as string[],
    undone: [] as string[],
    away: [] as string[],
  };
  const fail = { history: null as Error | null };
  type Row = { id: string; space: string; projectId: string; title: string; settings: { agent: "claude"; model: null; effort: null; mode: "act"; permissionMode: "trusted" } };
  const rows = new Map<string, Row>();
  const made = new Map<string, Row>();
  const leaving = new Set<string>();
  const cloud = {
    save: null as null | { branch: string; head: string; base: string; bundle: boolean; uncommitted: boolean; savedAt: string },
    bundle: "",
    session: null as Buffer | null,
    events: [] as AgentEvent[],
    summaryProject: "",
  };
  const hosted = {
    spaces: { status: () => ({ state: "ready", personalSpaceId: "personal" }) },
    threads: {
      holds: ({ thread }: { thread: string }) => rows.has(thread),
      row: (id: string) => {
        const row = rows.get(id);
        if (!row) throw new Error("That conversation isn't on OpenOrc Cloud.");
        return row;
      },
      summary: (id: string) => ({ id, projectId: cloud.summaryProject }),
      cloudProjectFor: () => ({ id: "cloud-app", space: "personal" }),
      // The Mac hears a thread made on the server once it reads the server again.
      refresh: async () => {
        made.forEach((row, id) => rows.set(id, row));
        leaving.forEach((id) => rows.delete(id));
      },
    },
    moves: {
      arrive: async (space: string, input: { id: string; projectId: string }) => (sent.arrived.push({ space, id: input.id, projectId: input.projectId }), { id: input.id }),
      history: async (_space: string, _id: string, lines: () => AsyncIterable<ArrivalLine>) => {
        if (fail.history) throw fail.history;
        for await (const line of lines()) sent.history.push(line);
        return { turns: sent.history.length };
      },
      session: async (_space: string, _id: string, query: { agent: string; sessionId: string; cliVersion: string }, packed: Uint8Array) => (
        (sent.session = { query, packed }),
        { bytes: packed.length }
      ),
      work: async (_space: string, _id: string, upload: { query: Record<string, string>; chunks(): AsyncIterable<Uint8Array> }) => {
        let bytes = 0;
        for await (const chunk of upload.chunks()) bytes += chunk.length;
        sent.work = { query: upload.query, bytes };
      },
      done: async (_space: string, id: string) => {
        sent.done.push(id);
        made.set(id, { id, space: "personal", projectId: "cloud-app", title: "Moved", settings: { agent: "claude", model: null, effort: null, mode: "act", permissionMode: "trusted" } });
        return { id };
      },
      undo: async (_space: string, id: string) => void sent.undone.push(id),
      events: async function* () {
        for (const event of cloud.events) yield event;
      },
      savedSession: async () => (cloud.session ? new Response(new Uint8Array(cloud.session)) : new Response(null, { status: 404 })),
      movedAway: async (_space: string, id: string) => {
        sent.away.push(id);
        leaving.add(id);
      },
    },
    macProjects: {
      workSave: async () => ({ save: cloud.save, current: true, working: false, ends: [] }),
      ask: async () => ({ asked: true }),
      bundle: async () => new Response(new Uint8Array(await readFile(cloud.bundle))),
    },
  } as unknown as Hosted;
  return { hosted, sent, fail, rows, cloud };
}

function moves(hosted: Hosted, deleted: string[] = [], changed: (id: string) => void = () => {}, platform = "darwin") {
  return new CloudMoves({
    db,
    hosted: () => hosted,
    sessions: new AgentSessions({ db, dataDir: path.join(root, "data"), homes }),
    ledger,
    workspaces,
    deleteThread: async (id) => {
      deleted.push(id);
      threads.delete(db, id);
    },
    changed,
    here: computerNames(platform),
    log: quiet,
  });
}

/** A Claude thread working in the project's checkout, with one exchange and its agent's conversation on this Mac. */
async function macThread() {
  const project = projects.insert(db, { name: "App", rootPath: folder, gitRemote: "https://github.com/acme/app.git", defaultBranch: "main", settings: {} });
  const made = threads.insert(db, { projectId: project.id, title: "Fix the login", agent: "claude", model: null, mode: "act", permissionMode: "trusted", workspaceMode: "current" });
  const thread = threads.update(db, made.id, { baseSha: git(folder, "rev-parse", "HEAD"), branch: "main" });
  runs.insert(db, { id: "run-1", taskId: null, threadId: thread.id, agent: "claude", model: null, mode: "act", permissionMode: "trusted" });
  runs.update(db, "run-1", { state: "success", externalSessionId: SESSION, endedAt: Date.now() });
  ledger.push({ type: "message.completed", runId: "run-1", ts: 1_000, messageId: "user-1", role: "user", text: "Remember the word pelican" });
  ledger.push({ type: "message.completed", runId: "run-1", ts: 2_000, messageId: "assistant-1", role: "assistant", text: "Noted: pelican" });
  ledger.flush();
  const file = claudeSessionFile(claude, folder, SESSION);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify({ type: "user", cwd: folder, sessionId: SESSION, text: "Remember the word pelican" })}\n`);
  await writeFile(path.join(folder, "LOCAL.md"), "not committed yet\n");
  return { project, thread };
}

const settled = (id: string) => vi.waitFor(() => expect(cloudMoves.open(db, id)).toBeNull(), { timeout: 10_000 });

describe("a thread moving from this Mac to OpenOrc Cloud", () => {
  it("sends its transcript, its conversation and its folder's work under its own id, then goes from this Mac", async () => {
    const { thread } = await macThread();
    const { hosted, sent } = account();
    const deleted: string[] = [];
    const cloudMovesService = moves(hosted, deleted);
    expect(await cloudMovesService.check(thread.id)).toEqual({ to: "cloud", can: true, space: { id: "personal", personal: true } });
    expect(await cloudMovesService.move(thread.id, false)).toEqual({ started: true });
    await settled(thread.id);
    expect(sent.arrived).toEqual([{ space: "personal", id: thread.id, projectId: "cloud-app" }]);
    expect(sent.history).toMatchObject([
      { kind: "turn", thread: thread.id, message: { text: "Remember the word pelican" }, events: [{ type: "message.completed", role: "assistant", text: "Noted: pelican" }] },
    ]);
    expect(sent.history[0]!.kind === "turn" && sent.history[0]!.events[0]).not.toHaveProperty("runId");
    const session = unpackSession(Buffer.from(sent.session!.packed));
    expect(sent.session!.query).toEqual({ agent: "claude", sessionId: SESSION, cliVersion: "2.1.317" });
    expect(session.parts[0]!.bytes.toString("utf8")).toContain("Remember the word pelican");
    expect(sent.work?.query["base"]).toBe(git(folder, "rev-parse", "origin/main"));
    expect(sent.work!.bytes).toBeGreaterThan(0);
    expect(sent.done).toEqual([thread.id]);
    expect(deleted).toEqual([thread.id]);
    expect(cloudMoves.moving(db, thread.id)).toBeNull();
  });

  it("sends the folder's work of a thread with no base of its own, as one imported from a terminal", async () => {
    const { thread } = await macThread();
    threads.update(db, thread.id, { baseSha: null });
    const { hosted, sent } = account();
    await moves(hosted).move(thread.id, false);
    await settled(thread.id);
    expect(sent.work!.bytes).toBeGreaterThan(0);
    expect(sent.done).toEqual([thread.id]);
  });

  it("stays where it was, undone on the server, and says why, when a step fails", async () => {
    const { thread } = await macThread();
    const { hosted, sent, fail } = account();
    fail.history = new Error("This thread holds a bogus.event event OpenOrc Cloud doesn't read yet.");
    const deleted: string[] = [];
    const service = moves(hosted, deleted);
    await service.move(thread.id, false);
    await settled(thread.id);
    expect(sent.undone).toEqual([thread.id]);
    expect(deleted).toEqual([]);
    expect(threads.get(db, thread.id)).not.toBeNull();
    expect(cloudMoves.moving(db, thread.id)).toEqual({ to: "cloud", failed: "This thread holds a bogus.event event OpenOrc Cloud doesn't read yet." });
    service.dismiss(thread.id);
    expect(cloudMoves.moving(db, thread.id)).toBeNull();
  });

  it("picks up a move OpenOrc closed on: one the server finished goes from this Mac, one it didn't stays here, undone there", async () => {
    const { project, thread: finished } = await macThread();
    const left = threads.insert(db, { projectId: project.id, title: "Draft the notes", agent: "claude", model: null, mode: "act", permissionMode: "trusted", workspaceMode: "current" });
    const { hosted, sent } = account();
    await hosted.moves.done("personal", finished.id);
    cloudMoves.begin(db, { threadId: finished.id, direction: "to-cloud", projectId: project.id });
    const cut = cloudMoves.begin(db, { threadId: left.id, direction: "to-cloud", projectId: project.id });
    cloudMoves.set(db, cut.id, { phase: "sending", step: "history" });
    const deleted: string[] = [];
    await moves(hosted, deleted).resume();
    expect(deleted).toEqual([finished.id]);
    expect(sent.undone).toEqual([left.id]);
    expect(cloudMoves.moving(db, left.id)).toEqual({ to: "cloud", failed: "This move stopped when OpenOrc closed. Try again." });
  });

  it("holds a thread that isn't the account's to move, with why", async () => {
    const { thread } = await macThread();
    const { hosted } = account();
    const service = moves(hosted);
    runs.insert(db, { id: "run-2", taskId: null, threadId: thread.id, agent: "claude", model: null, mode: "act", permissionMode: "trusted" });
    runs.update(db, "run-2", { state: "running" });
    expect(await service.check(thread.id)).toEqual({ to: "cloud", can: false, reason: "The agent is still working. Move it once it stops." });
    runs.update(db, "run-2", { state: "success" });
    cloudMoves.begin(db, { threadId: thread.id, direction: "to-cloud", projectId: null });
    expect(await service.check(thread.id)).toEqual({ to: "cloud", can: false, reason: "Moving to OpenOrc Cloud" });
  });
});

describe("a cloud thread moving to this Mac", () => {
  /** A cloud thread of the person's own space on the project, with a save of a commit and an uncommitted edit. */
  async function cloudThread(made: ReturnType<typeof account>, project: { id: string }) {
    const id = "6f1c2d3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f";
    made.rows.set(id, { id, space: "personal", projectId: "cloud-app", title: "Fix the login", settings: { agent: "claude", model: null, effort: null, mode: "act", permissionMode: "trusted" } });
    made.cloud.summaryProject = project.id;
    const cloud = path.join(root, "cloud");
    git(root, "clone", "-q", path.join(root, "github.git"), cloud);
    const base = git(cloud, "rev-parse", "HEAD");
    git(cloud, "checkout", "-q", "-b", "openorc/fix-the-login-6f1c2d3e");
    await writeFile(path.join(cloud, "FIX.md"), "committed in the cloud\n");
    git(cloud, "add", "-A");
    git(cloud, "commit", "-q", "-m", "Fix");
    await writeFile(path.join(cloud, "README.md"), "edited in the cloud, not committed\n");
    const index = { ...env, GIT_INDEX_FILE: path.join(root, "wip-index") };
    execFileSync("git", ["read-tree", "HEAD"], { cwd: cloud, env: index });
    execFileSync("git", ["add", "-A"], { cwd: cloud, env: index });
    const tree = execFileSync("git", ["write-tree"], { cwd: cloud, env: index, encoding: "utf8" }).trim();
    const wip = git(cloud, "commit-tree", tree, "-p", "HEAD", "-m", "wip");
    git(cloud, "update-ref", "refs/openorc/saved/wip", wip);
    made.cloud.bundle = path.join(root, "save.bundle");
    git(cloud, "bundle", "create", "-q", made.cloud.bundle, "refs/openorc/saved/wip", "refs/heads/openorc/fix-the-login-6f1c2d3e", `^${base}`);
    made.cloud.save = { branch: "openorc/fix-the-login-6f1c2d3e", head: git(cloud, "rev-parse", "HEAD"), base, bundle: true, uncommitted: true, savedAt: new Date().toISOString() };
    made.cloud.session = packSession({
      agent: "claude",
      format: 1,
      cliVersion: "2.1.317",
      sessionId: SESSION,
      parts: [{ name: "session.jsonl", bytes: Buffer.from(`${JSON.stringify({ type: "user", cwd: "/vercel/sandbox/repo", sessionId: SESSION, text: "In the cloud" })}\n`) }],
      meta: {},
    });
    made.cloud.events = [
      { type: "message.completed", runId: `hosted:${id}`, ts: 1_000, messageId: "user-a", role: "user", text: "Fix the login" },
      { type: "message.completed", runId: `hosted:${id}`, ts: 2_000, messageId: "agent-a", role: "assistant", text: "Fixed it" },
    ];
    return id;
  }

  it("comes with its transcript, its conversation and its work on its branch, and goes from the cloud", async () => {
    const project = projects.insert(db, { name: "App", rootPath: folder, gitRemote: "https://github.com/acme/app.git", defaultBranch: "main", settings: {} });
    const made = account();
    const id = await cloudThread(made, project);
    // Each time the thread is said to have changed: whether it has arrived here while the Mac still reads it from the cloud.
    const both: boolean[] = [];
    const service = moves(made.hosted, [], (changed) => both.push(cloudMoves.latest(db, changed)?.phase === "done" && made.hosted.threads.holds({ thread: changed })));
    expect(await service.check(id)).toEqual({ to: "mac", can: true, ends: [] });
    await service.move(id, false);
    await settled(id);
    expect(cloudMoves.latest(db, id)).toMatchObject({ phase: "done", error: null });
    expect(both).not.toContain(true);
    expect(made.sent.away).toEqual([id]);
    const here = threads.get(db, id)!;
    expect(here).toMatchObject({ projectId: project.id, title: "Fix the login", branch: "openorc/fix-the-login-6f1c2d3e", importedFrom: `cloud:${id}` });
    const [run] = runs.listForThread(db, id);
    expect(run).toMatchObject({ state: "success", externalSessionId: SESSION });
    expect(listEvents(db, run!.id).map((event) => (event.type === "message.completed" ? `${event.role}: ${event.text}` : event.type))).toEqual(["user: Fix the login", "assistant: Fixed it"]);
    expect(await readFile(path.join(here.worktreePath!, "FIX.md"), "utf8")).toBe("committed in the cloud\n");
    expect(await readFile(path.join(here.worktreePath!, "README.md"), "utf8"), "what it had not committed is back in its files").toBe("edited in the cloud, not committed\n");
    expect(git(here.worktreePath!, "status", "--porcelain")).toBe("M README.md");
    const taken = await readFile(claudeSessionFile(claude, here.worktreePath!, SESSION), "utf8");
    expect(taken).toContain(here.worktreePath!);
  });

  it("comes into a worktree at its base, its conversation with it, when the cloud kept nothing beyond the base", async () => {
    const project = projects.insert(db, { name: "App", rootPath: folder, gitRemote: "https://github.com/acme/app.git", defaultBranch: "main", settings: {} });
    const made = account();
    const id = await cloudThread(made, project);
    made.cloud.save = { ...made.cloud.save!, bundle: false, uncommitted: false };
    await moves(made.hosted).move(id, false);
    await settled(id);
    const here = threads.get(db, id)!;
    expect(git(here.worktreePath!, "rev-parse", "HEAD")).toBe(made.cloud.save.base);
    expect(await readFile(claudeSessionFile(claude, here.worktreePath!, SESSION), "utf8")).toContain(here.worktreePath!);
  });

  it("leaves a folder of the thread's with other work alone, and stays in the cloud", async () => {
    const project = projects.insert(db, { name: "App", rootPath: folder, gitRemote: "https://github.com/acme/app.git", defaultBranch: "main", settings: {} });
    const made = account();
    const id = await cloudThread(made, project);
    const service = moves(made.hosted);
    const at = workspaces.threadPath({ id, title: "Fix the login", workspaceMode: "worktree", worktreePath: null }, project);
    await mkdir(at, { recursive: true });
    git(root, "init", "-q", at);
    await writeFile(path.join(at, "MINE.md"), "someone's own work\n");
    await service.move(id, false);
    await settled(id);
    expect(cloudMoves.moving(db, id)).toEqual({
      to: "mac",
      failed: "A folder for this thread is already where its worktree goes, with other work in it. Move that work aside, then try again.",
      folder: at,
    });
    expect(made.sent.away).toEqual([]);
    expect(threads.get(db, id)).toBeNull();
    expect(await readFile(path.join(at, "MINE.md"), "utf8")).toBe("someone's own work\n");
  });

  it("holds a thread of a team's space, with why", async () => {
    const project = projects.insert(db, { name: "App", rootPath: folder, gitRemote: "https://github.com/acme/app.git", defaultBranch: "main", settings: {} });
    const made = account();
    const id = await cloudThread(made, project);
    made.rows.set(id, { ...made.rows.get(id)!, space: "acme" });
    expect(await moves(made.hosted).check(id)).toEqual({ to: "mac", can: false, reason: "Only a thread in your own space can move to this Mac." });
  });

  it("names this computer as the app does where it isn't a Mac", async () => {
    const project = projects.insert(db, { name: "App", rootPath: folder, gitRemote: "https://github.com/acme/app.git", defaultBranch: "main", settings: {} });
    const made = account();
    const id = await cloudThread(made, project);
    made.rows.set(id, { ...made.rows.get(id)!, space: "team" });
    expect(await moves(made.hosted, [], () => {}, "linux").check(id)).toEqual({ to: "mac", can: false, reason: "Only a thread in your own space can move to this computer." });
    expect(await moves(made.hosted, [], () => {}, "win32").check(id)).toEqual({ to: "mac", can: false, reason: "Only a thread in your own space can move to this PC." });
  });
});
