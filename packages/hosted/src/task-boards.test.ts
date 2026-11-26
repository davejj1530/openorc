import { randomUUID } from "node:crypto";
import { OnlineBoard, OnlineTask } from "@openorc/protocol";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHosted, type HostedDeps } from "./index.js";
import { Session } from "./session.js";
import { OnlineTasks } from "./tasks.js";
import { hostDeps, newDevice, signInAs, storedToken } from "./test-fixtures/host.js";
import { standIn, type StandIn } from "./testing/stand-in.js";

let stand: StandIn;
let spaceId: string, projectId: string;
const ADMIN = "alex@example.com",
  MEMBER = "sam@example.com";
const close: (() => void)[] = [];
beforeEach(async () => {
  stand = await standIn({ signup: "open" });
  stand.tasks.enabled = true;
  stand.threadFiles.capabilities = { board: { available: true } };
  spaceId = stand.addTeam("Birch Studio", [ADMIN, MEMBER]);
  projectId = stand.addProject(ADMIN, { name: "Canvas", fullName: "example/canvas" }, spaceId);
});
afterEach(async () => {
  close
    .splice(0)
    .reverse()
    .forEach((stop) => stop());
  await stand.close();
});
async function client(email: string, overrides: Partial<HostedDeps> = {}): Promise<OnlineTasks> {
  const device = newDevice(),
    { deps, browser } = hostDeps(stand, device, overrides);
  const hosted = createHosted(deps);
  close.push(() => hosted.close());
  await hosted.start();
  await signInAs(hosted, browser, email);
  await vi.waitFor(() => expect(hosted.spaces.status().state).toBe("ready"));
  const session = new Session(deps);
  await session.begin(storedToken(device), email);
  close.push(() => session.close());
  const tasks = new OnlineTasks({ session, spaces: hosted.spaces, push: deps.push, delivery: { organization: true, personal: false } });
  close.push(() => tasks.close());
  return tasks;
}
const columns = [
  { name: "Backlog", stage: "backlog" as const },
  { name: "Build", stage: "in_progress" as const, job: { prompt: "Build it.", choice: null } },
  { name: "Code review", stage: "in_progress" as const },
  { name: "Done", stage: "done" as const },
];
const save = (tasks: OnlineTasks, ifRevision: number, next: Parameters<OnlineTasks["saveBoard"]>[0]["columns"]) =>
  tasks.saveBoard({ spaceId, projectId, requestId: randomUUID(), ifRevision, columns: next });
const create = async (tasks: OnlineTasks) => (await tasks.create({ spaceId, projectId, requestId: randomUUID(), title: "Export activity" })).task;
const move = async (tasks: OnlineTasks, task: OnlineTask, patch: { columnId?: string; status?: OnlineTask["status"] }) => {
  const result = await tasks.update({ spaceId, id: task.id, requestId: randomUUID(), ifRevision: task.revision, patch });
  if (result.state !== "saved") throw new Error("not saved");
  return result.task;
};

it("reads the server's boards capability, and a server without it keeps the statuses", async () => {
  const tasks = await client(ADMIN);
  expect(await tasks.state({ spaceId })).toMatchObject({ state: "ready", board: true, execution: false });
  expect(await tasks.board({ spaceId, projectId })).toEqual({ revision: 0, columns: [], mayEdit: true });
  stand.threadFiles.capabilities = null;
  const old = await client(MEMBER);
  expect(await old.state({ spaceId })).toMatchObject({ state: "ready", board: false });
  expect(await old.board({ spaceId, projectId })).toEqual({ revision: 0, columns: [], mayEdit: false });
  expect(stand.requests.some((request) => request.path.endsWith("/board") && request.authorized && request.method === "GET")).toBe(true);
  await expect(save(old, 0, columns)).rejects.toThrow("keep no columns");
});

it("shares one board between people, and a save from an older revision answers the board as it now is", async () => {
  const a = await client(ADMIN),
    b = await client(MEMBER);
  const saved = await save(a, 0, columns);
  expect(saved).toMatchObject({ state: "saved", revision: 1 });
  expect(saved.columns.map((column) => [column.name, column.stage, column.jobEnabled])).toEqual([
    ["Backlog", "backlog", true],
    ["Build", "in_progress", true],
    ["Code review", "in_progress", true],
    ["Done", "done", true],
  ]);
  expect(saved.columns[1]!.job).toEqual({ prompt: "Build it.", choice: null });
  expect(await b.board({ spaceId, projectId })).toEqual({ revision: 1, columns: saved.columns, mayEdit: false });

  stand.spaces.member(spaceId, MEMBER)!.role = "admin";
  const late = await save(b, 0, [{ name: "Only", stage: "backlog" }]);
  expect(late).toEqual({ state: "conflict", revision: 1, columns: saved.columns, mayEdit: true });
  expect((await a.board({ spaceId, projectId })).columns).toHaveLength(4);
});

it("hands a column's work on only to a later column", async () => {
  const a = await client(ADMIN);
  const first = await save(a, 0, columns);
  const [backlog, build, review, done] = first.columns;
  const next = await save(a, 1, [{ ...backlog!, nextColumnId: build!.id }, { ...build!, nextColumnId: review!.id }, { ...review!, nextColumnId: backlog!.id }, done!]);
  expect(next.columns.map((column) => column.nextColumnId)).toEqual([build!.id, review!.id, null, null]);
});

it("puts a task in a column with its stage, sends a status alone to the first column of that stage, and keeps moves in history by name", async () => {
  const a = await client(ADMIN);
  const [, build, review] = (await save(a, 0, columns)).columns;
  const made = await create(a);
  expect(made.columnId).toBeNull();
  const built = await move(a, made, { columnId: build!.id });
  expect(built).toMatchObject({ status: "in_progress", columnId: build!.id });
  const reviewed = await move(a, built, { columnId: review!.id });
  expect(reviewed).toMatchObject({ status: "in_progress", columnId: review!.id });
  const finished = await move(a, reviewed, { status: "done" });
  expect(finished.columnId).toBe((await a.board({ spaceId, projectId })).columns[3]!.id);
  expect(finished.completedAt).not.toBeNull();
  const archived = await move(a, finished, { status: "archived" });
  expect(archived.columnId).toBeNull();

  const history = await a.activity({ spaceId, id: made.id });
  expect(history.entries.map((entry) => [entry.kind, entry.column ?? null, Object.keys(entry.changes)])).toEqual([
    ["created", null, []],
    ["status_changed", { before: null, after: "Build" }, ["status"]],
    ["edited", { before: "Build", after: "Code review" }, []],
    ["status_changed", { before: "Code review", after: "Done" }, ["status"]],
    ["status_changed", { before: "Done", after: null }, ["status"]],
  ]);
  await expect(a.update({ spaceId, id: made.id, requestId: randomUUID(), ifRevision: archived.revision, patch: { columnId: "gone" } })).rejects.toThrow("no longer on the board");
});

it("takes a column's tasks with it when its stage changes, and leaves them their status when it is removed", async () => {
  const a = await client(ADMIN);
  const [backlog, build, review, done] = (await save(a, 0, columns)).columns;
  const task = await move(a, await create(a), { columnId: review!.id });
  await save(a, 1, [backlog!, build!, { ...review!, stage: "review" }, done!]);
  const restaged = (await a.get({ spaceId, id: task.id })).task;
  expect(restaged).toMatchObject({ status: "review", columnId: review!.id });
  await save(a, 2, [backlog!, build!, done!]);
  const removed = (await a.get({ spaceId, id: task.id })).task;
  expect(removed).toMatchObject({ status: "review", columnId: null });
  const entries = (await a.activity({ spaceId, id: task.id })).entries.slice(-2);
  expect(entries.map((entry) => [entry.kind, entry.column ?? null, entry.changes])).toEqual([
    ["status_changed", null, { status: { before: "in_progress", after: "review" } }],
    ["edited", { before: "Code review", after: null }, {}],
  ]);
});

it("answers a lost save's retry once, and refuses a request id reused for other columns", async () => {
  const a = await client(ADMIN);
  const requestId = randomUUID();
  const first = await a.saveBoard({ spaceId, projectId, requestId, ifRevision: 0, columns });
  expect(await a.saveBoard({ spaceId, projectId, requestId, ifRevision: 0, columns })).toEqual(first);
  await expect(a.saveBoard({ spaceId, projectId, requestId, ifRevision: 0, columns: columns.slice(1) })).rejects.toThrow("already used");
});

it("parses an older server's task, which names no column", () => {
  const task = stand.tasks.seed(spaceId, ADMIN, projectId);
  const { columnId: _gone, ...old } = task;
  expect(OnlineTask.parse(old).columnId).toBeUndefined();
});

it("lets only an organization's admins change its board, while anyone who works on its tasks moves them between columns", async () => {
  const admin = await client(ADMIN),
    member = await client(MEMBER);
  const [, build] = (await save(admin, 0, columns)).columns;
  await expect(save(member, 1, [{ name: "Mine", stage: "backlog" }])).rejects.toThrow("Only an organization admin can change this board's columns.");
  expect((await member.board({ spaceId, projectId })).columns).toHaveLength(4);
  expect(await move(member, await create(member), { columnId: build!.id })).toMatchObject({ columnId: build!.id, status: "in_progress" });
});

it("reads an older board answer that names no editor as one nobody may change", () => {
  expect(OnlineBoard.parse({ revision: 2, columns: [] })).toEqual({ revision: 2, columns: [], mayEdit: false });
});
