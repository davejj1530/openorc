import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import { Session } from "./session.js";
import { TaskChanged, taskRequest } from "./task-requests.js";
import type { LiveSocket } from "./index.js";

const socket: LiveSocket = {
  onState() {},
  on() {},
  async ask() {
    return null;
  },
  close() {},
};
const sessions: Session[] = [];
afterEach(() => sessions.splice(0).forEach((session) => session.close()));
const current = {
  accessRevision: 7,
  task: {
    id: "task-a",
    spaceId: "team-a",
    organizationId: "team-a",
    projectId: "project-a",
    title: "Export report",
    spec: "Saved words",
    status: "backlog",
    priority: "none",
    labels: [],
    origin: "user",
    creator: { userId: "person-a", name: "Alex", image: null },
    updatedBy: null,
    assignee: null,
    revision: 2,
    assignmentRevision: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    completedAt: null,
    createdIn: { state: "private", threadId: "must-not-escape", title: "Private words" },
    execution: { state: "none" },
    activity: null,
    viewer: { unseenAssignment: false, attention: [], mayEdit: true, mayDelete: true, mayOpenThread: false, liveExecution: false },
  },
};
async function request(status: number, body: unknown) {
  const session = new Session({
    server: "http://127.0.0.1:1",
    session: { load: async () => null, save: async () => undefined },
    fetch: async () => new Response(JSON.stringify(body), { status }),
    connect: () => socket,
    now: Date.now,
    log: { info() {}, warn() {} },
  });
  sessions.push(session);
  await session.begin("synthetic-token", "alex@example.com");
  const answer = session.in("team-a").request(taskRequest({ method: "PATCH", path: "/tasks/task-a", reply: z.null() }), {});
  return { session, answer };
}
it("returns the authorized conflicting revision and strips private-link metadata", async () => {
  const { answer } = await request(409, { code: "TASK_CHANGED", message: "This task changed.", current });
  await expect(answer).rejects.toBeInstanceOf(TaskChanged);
  await expect(answer).rejects.toMatchObject({ current: { accessRevision: 7, task: { revision: 2, createdIn: { state: "private" } } } });
  await answer.catch((error: unknown) => {
    if (!(error instanceof TaskChanged)) throw error;
    expect(error.current.task.createdIn).toEqual({ state: "private" });
    expect(error.current.task.createdAt).toBe(Date.parse("2026-01-01T00:00:00.000Z"));
  });
});
it("ends a 401 session before considering task conflict data", async () => {
  const { session, answer } = await request(401, { code: "TASK_CHANGED", current });
  await expect(answer).rejects.toThrow("session ended");
  expect(session.state.signedIn).toBe(false);
});
it("never exposes malformed conflict data or unrelated errors", async () => {
  for (const body of [
    { code: "TASK_CHANGED", current: { secret: "hidden" } },
    { code: "OTHER", current },
  ]) {
    const { answer } = await request(409, { ...body, message: "Try again." });
    await expect(answer).rejects.toMatchObject({ message: "Try again." });
    await answer.catch((error: unknown) => expect(error).not.toHaveProperty("current"));
  }
});
