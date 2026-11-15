import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { HostedDeps } from "./index.js";
import { taskClient } from "./test-fixtures/task-client.js";
import { standIn, type StandIn } from "./testing/stand-in.js";

let stand: StandIn;
let spaceId: string, projectId: string;
const close: (() => void)[] = [];
const ADMIN = "alex@example.com",
  MEMBER = "sam@example.com";
beforeEach(async () => {
  stand = await standIn({ signup: "open" });
  stand.tasks.enabled = true;
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
const TASKS_OFF = { available: false as const, reason: "Task tools aren't available in cloud threads yet." };
async function client(email = ADMIN, overrides: Partial<HostedDeps> = {}, execution = true) {
  stand.threadFiles.capabilities = { tasks: execution ? { available: true } : TASKS_OFF };
  const result = await taskClient(stand, email, { organization: true, personal: false }, overrides);
  close.push(result.close);
  return result.tasks;
}
const seed = () => stand.tasks.seed(spaceId, ADMIN, projectId, { title: "Keep the task document", spec: "Preserve the writer's words." });
const input = (task: ReturnType<typeof seed>) => ({ spaceId, id: task.id, ifRevision: task.revision, requestId: randomUUID() });

it("knows a newly prepared thread in the hosted router before returning its destination", async () => {
  stand.threadFiles.capabilities = { tasks: { available: true } };
  const current = await taskClient(stand, ADMIN, { organization: true, personal: false });
  close.push(current.close);
  const result = await current.tasks.openThread(input(seed()));
  if (result.state !== "ready") throw new Error("Preparation conflicted");
  expect(current.hosted.threads.holds({ thread: result.threadId })).toBe(true);
  expect(await current.hosted.threads.call("threads.get", { id: result.threadId })).toMatchObject({ id: result.threadId, owner: { brain: "hosted" } });
});

it("holds a newly prepared thread in the app's own client before returning it, when the server's notice comes during that read", async () => {
  stand.threadFiles.capabilities = { tasks: { available: true } };
  let opened = false;
  // As the real server can: its change notice arrives after the reply, while the client reads its threads again.
  const current = await taskClient(
    stand,
    ADMIN,
    { organization: true, personal: false },
    {
      fetch: async (url, init) => {
        if (String(url).endsWith("/open-thread")) opened = true;
        else if (opened && new URL(String(url)).pathname === "/hosted/threads") await new Promise((resolve) => setTimeout(resolve, 600));
        return fetch(url, init);
      },
      connect: (url, token) => {
        const socket = stand.connect(url, token);
        return {
          onState: (listener) => socket.onState(listener),
          on: (event, listener) => socket.on(event, event === "changed" ? (body) => void setTimeout(() => listener(body), opened ? 300 : 0) : listener),
          ask: (event, body) => socket.ask(event, body),
          close: () => socket.close(),
        };
      },
    },
  );
  close.push(current.close);
  const result = await current.hosted.tasks.openThread(input(seed()));
  if (result.state !== "ready") throw new Error("Preparation conflicted");
  expect(current.hosted.threads.holds({ thread: result.threadId })).toBe(true);
  expect(await current.hosted.threads.call("threads.get", { id: result.threadId })).toMatchObject({ id: result.threadId, owner: { brain: "hosted" } });
});

it("opens one shared thread for two people without preparing or starting a paid turn", async () => {
  const a = await client(),
    b = await client(MEMBER),
    task = seed();
  const [first, second] = await Promise.all([a.openThread(input(task)), b.openThread(input(task))]);
  expect(first.state).toBe("ready");
  expect(second.state).toBe("ready");
  if (first.state !== "ready" || second.state !== "ready") throw new Error("Preparation conflicted");
  expect(first.threadId).toBe(second.threadId);
  expect([first.created, second.created].filter(Boolean)).toHaveLength(1);
  expect(first.task.status).toBe("backlog");
  expect(first.task.activity).toBeNull();
  expect(first.draft).toBe(`Work on "${task.title}" in this thread.\n\n${task.spec}`);
  expect(stand.readies).toHaveLength(0);
  expect(stand.started).toHaveLength(0);
  expect(stand.sent).toHaveLength(0);
});
it("repeats a lost preparation receipt with the same id and keeps the thread", async () => {
  let lost = false;
  const tasks = await client(ADMIN, {
    fetch: async (url, init) => {
      const response = await fetch(url, init);
      if (!lost && String(url).endsWith("/open-thread") && response.ok) {
        lost = true;
        await response.text();
        throw new TypeError("Reply lost");
      }
      return response;
    },
  });
  const task = seed(),
    request = input(task);
  await expect(tasks.openThread(request)).rejects.toThrow("can't be reached");
  expect(lost).toBe(true);
  const replay = await tasks.openThread(request);
  expect(replay.state).toBe("ready");
  if (replay.state !== "ready") throw new Error("Preparation conflicted");
  const reopened = await tasks.openThread(input(task));
  expect(reopened).toMatchObject({ state: "ready", threadId: replay.threadId, created: false });
  await expect(tasks.openThread({ ...request, ifRevision: request.ifRevision + 1 })).rejects.toThrow("already used");
});
it("returns a competing document before first preparation and requires an explicit new revision", async () => {
  const tasks = await client(),
    task = seed(),
    request = input(task);
  const saved = await tasks.update({ ...request, patch: { title: "The saved title" } });
  expect(await tasks.openThread(request)).toMatchObject({ state: "conflict", task: { title: "The saved title", revision: saved.task.revision } });
  expect(await tasks.openThread({ ...request, requestId: randomUUID(), ifRevision: saved.task.revision })).toMatchObject({ state: "ready" });
});
it("refuses an unavailable execution link without making a replacement", async () => {
  const tasks = await client(),
    task = seed();
  task.execution = { state: "unavailable" };
  await expect(tasks.openThread(input(task))).rejects.toThrow("Thread unavailable");
  expect(task.execution).toEqual({ state: "unavailable" });
  expect(stand.started).toHaveLength(0);
});
it("keeps the execution gate closed without a preparation request", async () => {
  const tasks = await client(ADMIN, {}, false),
    task = seed();
  const before = stand.requests.length;
  await expect(tasks.openThread(input(task))).rejects.toThrow("isn't available yet");
  expect(stand.requests.slice(before).some((request) => request.path.endsWith("/open-thread"))).toBe(false);
});

it("opens task threads as the server's tasks capability says, asking a server without one once a session", async () => {
  const asked = () => stand.requests.filter((request) => request.path === "/hosted/capabilities").length;
  stand.threadFiles.capabilities = null;
  const older = await taskClient(stand, ADMIN, { organization: true, personal: false });
  close.push(older.close);
  expect(await older.tasks.state({ spaceId })).toMatchObject({ state: "ready", execution: false });
  expect(await older.tasks.state({ spaceId })).toMatchObject({ state: "ready", execution: false });
  await expect(older.tasks.openThread(input(seed()))).rejects.toThrow("isn't available yet");
  expect(asked()).toBe(1);
  expect(stand.requests.some((request) => request.path.endsWith("/open-thread"))).toBe(false);

  stand.threadFiles.capabilities = { tasks: { available: true } };
  const current = await taskClient(stand, ADMIN, { organization: true, personal: false });
  close.push(current.close);
  expect(await current.tasks.state({ spaceId })).toMatchObject({ state: "ready", execution: true });
  expect((await current.tasks.openThread(input(seed()))).state).toBe("ready");
  const before = asked();
  stand.threadFiles.capabilities = { tasks: TASKS_OFF };
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    expect(await current.tasks.state({ spaceId })).toMatchObject({ execution: true });
    expect(asked()).toBe(before);
    vi.setSystemTime(Date.now() + 5 * 60_000 + 1);
    expect(await current.tasks.state({ spaceId })).toMatchObject({ execution: false });
    expect(asked()).toBe(before + 1);
  } finally {
    vi.useRealTimers();
  }
});
