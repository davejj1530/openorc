import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHosted, type Hosted, type HostedDeps } from "./index.js";
import { Session } from "./session.js";
import { OnlineTasks } from "./tasks.js";
import { hostDeps, newDevice, signInAs, storedToken } from "./test-fixtures/host.js";
import { standIn, type StandIn } from "./testing/stand-in.js";
import { userOf } from "./testing/stand-in-spaces.js";

let stand: StandIn;
let spaceId: string, projectId: string, memberId: string;
const ADMIN = "alex@example.com",
  MEMBER = "sam@example.com";
const close: (() => void)[] = [];
beforeEach(async () => {
  stand = await standIn({ signup: "open" });
  stand.tasks.enabled = true;
  spaceId = stand.addTeam("Birch Studio", [ADMIN, MEMBER]);
  projectId = stand.addProject(ADMIN, { name: "Canvas", fullName: "example/canvas" }, spaceId);
  memberId = stand.spaces.member(spaceId, MEMBER)!.id;
});
afterEach(async () => {
  close
    .splice(0)
    .reverse()
    .forEach((stop) => stop());
  await stand.close();
});
async function client(email: string, overrides: Partial<HostedDeps> = {}): Promise<{ tasks: OnlineTasks; session: Session; hosted: Hosted }> {
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
  return { tasks, session, hosted };
}
const create = (tasks: OnlineTasks, extra = {}) => tasks.create({ spaceId, projectId, requestId: randomUUID(), title: "Export activity", spec: "Keep the current filters.", ...extra });

it("enables organization documents while keeping execution and Personal delivery closed", async () => {
  const { hosted } = await client(ADMIN);
  expect(await hosted.tasks.state({ spaceId })).toMatchObject({ state: "ready", execution: false, personal: false });
  expect((await hosted.tasks.list({ spaceId })).tasks).toEqual([]);
  const before = stand.requests.filter((request) => request.path.startsWith("/tasks")).length;
  const personal = { spaceId: `personal-${ADMIN}` };
  expect(await hosted.tasks.state(personal)).toEqual({ state: "unavailable" });
  await expect(hosted.tasks.list(personal)).rejects.toThrow("isn't available");
  expect(stand.requests.filter((request) => request.path.startsWith("/tasks"))).toHaveLength(before);
});
it("shows an assignment to both identities and acknowledges only its explicit open", async () => {
  const a = await client(ADMIN),
    b = await client(MEMBER);
  const made = await create(a.tasks, { assigneeMemberId: memberId });
  const target = { spaceId, id: made.task.id };
  expect(made.task.status).toBe("backlog");
  expect((await b.tasks.list({ spaceId })).tasks).toHaveLength(1);
  expect((await b.tasks.get(target)).task.viewer.unseenAssignment).toBe(true);
  expect((await b.tasks.attention({ spaceId })).count).toBe(1);
  expect((await a.tasks.attention({ spaceId })).count).toBe(0);
  await b.tasks.seen({ ...target, requestId: randomUUID(), assignmentRevision: made.task.assignmentRevision });
  expect((await b.tasks.attention({ spaceId })).count).toBe(0);
  expect((await b.tasks.get(target)).task.revision).toBe(made.task.revision);
});
it("deduplicates assignment, review and actionable asks while preserving review after opening", async () => {
  const a = await client(ADMIN),
    b = await client(MEMBER);
  const made = await create(a.tasks, { assigneeMemberId: memberId });
  const record = stand.tasks.records.get(made.task.id)!;
  record.task.status = "review";
  record.asks.add(userOf(MEMBER));
  expect((await b.tasks.get({ spaceId, id: made.task.id })).task.viewer.attention).toEqual(["assignment", "review", "ask"]);
  expect((await b.tasks.attention({ spaceId })).count).toBe(1);
  await b.tasks.seen({ spaceId, id: made.task.id, requestId: randomUUID(), assignmentRevision: made.task.assignmentRevision });
  expect((await b.tasks.attention({ spaceId })).count).toBe(1);
});
it("keeps a stale acknowledgement from clearing a later assignment and makes self-assignment seen", async () => {
  const a = await client(ADMIN),
    b = await client(MEMBER);
  let current = await create(a.tasks, { assigneeMemberId: memberId });
  const old = current.task.assignmentRevision;
  const target = { spaceId, id: current.task.id };
  current = await a.tasks.update({ ...target, requestId: randomUUID(), ifRevision: current.task.revision, patch: { assigneeMemberId: null } });
  current = await a.tasks.update({ ...target, requestId: randomUUID(), ifRevision: current.task.revision, patch: { assigneeMemberId: memberId } });
  await b.tasks.seen({ ...target, requestId: randomUUID(), assignmentRevision: old });
  expect((await b.tasks.attention({ spaceId })).count).toBe(1);
  const noChange = await a.tasks.update({ ...target, requestId: randomUUID(), ifRevision: current.task.revision, patch: { assigneeMemberId: memberId } });
  expect(noChange.task.revision).toBe(current.task.revision);
  const self = await create(b.tasks, { assigneeMemberId: memberId });
  expect(self.task.viewer.unseenAssignment).toBe(false);
});
it("returns both first and second conflicts without overwriting saved words", async () => {
  const a = await client(ADMIN),
    b = await client(MEMBER);
  const made = await create(a.tasks),
    target = { spaceId, id: made.task.id };
  let saved = await b.tasks.update({ ...target, requestId: randomUUID(), ifRevision: made.task.revision, patch: { spec: "The other person's words." } });
  const conflict = await a.tasks.update({ ...target, requestId: randomUUID(), ifRevision: made.task.revision, patch: { spec: "My words." } });
  expect(conflict).toMatchObject({ state: "conflict", task: { spec: "The other person's words.", revision: saved.task.revision } });
  saved = await b.tasks.update({ ...target, requestId: randomUUID(), ifRevision: saved.task.revision, patch: { spec: "A newer edit." } });
  expect(await a.tasks.update({ ...target, requestId: randomUUID(), ifRevision: conflict.task.revision, patch: { spec: "My words." } })).toMatchObject({
    state: "conflict",
    task: { spec: "A newer edit." },
  });
  expect((await a.tasks.get(target)).task.spec).toBe(saved.task.spec);
});
it("replays a lost reply with the same ID without creating or assigning twice", async () => {
  let lose = true;
  const a = await client(ADMIN, {
    fetch: async (url, init) => {
      const response = await fetch(url, init);
      if (init?.method === "POST" && new URL(String(url)).pathname === "/tasks" && lose) {
        lose = false;
        throw new Error("Lost reply");
      }
      return response;
    },
  });
  const input = { spaceId, projectId, requestId: randomUUID(), title: "Export activity", assigneeMemberId: memberId };
  await expect(a.tasks.create(input)).rejects.toThrow("can't be reached");
  const retry = await a.tasks.create(input);
  expect(stand.tasks.records.size).toBe(1);
  expect(retry.task.assignmentRevision).toBe(1);
  await expect(a.tasks.create({ ...input, title: "Changed payload" })).rejects.toThrow("already used");
});
it("uses the exact requested space and refuses wrong-space and inaccessible projects", async () => {
  const a = await client(ADMIN),
    b = await client(MEMBER);
  const other = stand.addTeam("Cedar Studio", [ADMIN]);
  const made = await create(a.tasks);
  await a.hosted.spaces.refresh();
  await expect(a.tasks.get({ spaceId: other, id: made.task.id })).rejects.toThrow("isn't available");
  const project = stand.spaces.project(spaceId, projectId)!;
  project.everyone = false;
  expect((await b.tasks.list({ spaceId })).tasks).toEqual([]);
  await expect(b.tasks.get({ spaceId, id: made.task.id })).rejects.toThrow("isn't available");
  expect((await b.tasks.attention({ spaceId })).count).toBe(0);
});
it("blocks frozen writes, keeps frozen assignment, and permits Done during work", async () => {
  const a = await client(ADMIN),
    b = await client(MEMBER);
  const made = await create(a.tasks, { assigneeMemberId: memberId });
  const record = stand.tasks.records.get(made.task.id)!;
  record.task.viewer.liveExecution = true;
  stand.tasks.frozen.add(MEMBER);
  await expect(b.tasks.get({ spaceId, id: made.task.id })).rejects.toThrow("frozen");
  expect((await a.tasks.assignees({ spaceId, projectId })).people.find((person) => person.memberId === memberId)?.available).toBe(false);
  const done = await a.tasks.update({ spaceId, id: made.task.id, requestId: randomUUID(), ifRevision: made.task.revision, patch: { status: "done" } });
  expect(done.task.assignee?.memberId).toBe(memberId);
  expect(done.task.viewer.liveExecution).toBe(true);
  await expect(a.tasks.delete({ spaceId, id: made.task.id, requestId: randomUUID(), ifRevision: done.task.revision })).rejects.toThrow("turn to finish");
});
it("reads again, under the access as it now stands, a read that a billing and members notice overtook", async () => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let held = false;
  const reads = () => stand.requests.filter((request) => request.path === "/tasks/attention").length;
  const notices: ((body: unknown) => void)[] = [];
  const a = await client(ADMIN, {
    connect: (url, token) => {
      const socket = stand.connect(url, token);
      return {
        onState: (listener) => socket.onState(listener),
        on: (event, listener) => {
          if (event === "changed") notices.push(listener);
          socket.on(event, listener);
        },
        ask: (event, body) => socket.ask(event, body),
        close: () => socket.close(),
      };
    },
    fetch: async (url, init) => {
      const response = await fetch(url, init);
      if (new URL(String(url)).pathname === "/tasks/attention" && !held) {
        held = true;
        await gate;
      }
      return response;
    },
  });
  const before = reads();
  const read = a.tasks.attention({ spaceId });
  await vi.waitFor(() => expect(held).toBe(true));
  // A seat count change tells the organization its billing and members changed; nobody's access did.
  for (const tell of notices) tell({ organizationId: spaceId, topics: ["billing", "members"] });
  release?.();
  expect(await read).toMatchObject({ count: 0 });
  expect(reads() - before).toBe(2);
});
it("discards an outstanding task reply after sign-out", async () => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const a = await client(ADMIN, {
    fetch: async (url, init) => {
      const response = await fetch(url, init);
      if (new URL(String(url)).pathname === "/tasks" && init?.method === "GET") await gate;
      return response;
    },
  });
  const read = a.tasks.list({ spaceId });
  await a.session.end("person");
  release?.();
  await expect(read).rejects.toThrow("isn't available");
});
