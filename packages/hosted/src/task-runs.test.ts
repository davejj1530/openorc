import { expect, it, vi } from "vitest";
import type { Session, SessionChange } from "./session.js";
import { TaskRuns } from "./task-runs.js";
import { SOCKET } from "./wire.js";

/** A session that hears what the test says the server sent, and answers requests as the test says. */
function standIn(answer: (method: string, path: string, body: unknown) => unknown) {
  const sockets = new Map<string, (body: unknown) => void>();
  const changes: ((change: SessionChange) => void)[] = [];
  const asked: { spaceId: string; method: string; path: string; body: unknown }[] = [];
  const session = {
    onSocket: (event: string, listener: (body: unknown) => void) => void sockets.set(event, listener),
    onChange: (listener: (change: SessionChange) => void) => void changes.push(listener),
    in: (spaceId: string) => ({
      request: async (route: { method: string; path: string; reply: { parse: (value: unknown) => unknown } }, body?: unknown) => {
        asked.push({ spaceId, method: route.method, path: route.path, body });
        return route.reply.parse(answer(route.method, route.path, body));
      },
    }),
  } as unknown as Session;
  return { session, asked, send: (event: string, body: unknown) => sockets.get(event)?.(body), change: (change: SessionChange) => changes.forEach((listener) => listener(change)) };
}

const spaces = {
  status: () => ({
    state: "ready",
    userId: "me",
    spaces: [
      { id: "org-1", kind: "organization" },
      { id: "org-2", kind: "organization" },
      { id: "me", kind: "personal" },
    ],
  }),
} as never;
const runs = (served: boolean) => ({ state: async () => ({ state: "ready", runs: served }) }) as never;
const task = {
  id: "task-1",
  spaceId: "org-1",
  organizationId: "org-1",
  projectId: "p",
  title: "Fix",
  spec: null,
  status: "in_progress",
  priority: "none",
  labels: [],
  origin: "user",
  creator: { userId: "a", name: "A", image: null },
  updatedBy: null,
  assignee: null,
  revision: 2,
  assignmentRevision: 1,
  createdAt: "2026-11-26T10:00:00.000Z",
  updatedAt: "2026-11-26T10:00:00.000Z",
  completedAt: null,
  createdIn: { state: "none" },
  execution: { state: "none" },
  activity: null,
  viewer: { unseenAssignment: false, attention: [], mayEdit: true, mayDelete: true, mayOpenThread: true, liveExecution: false },
};

it("says which organization may have runs waiting: one a notice names, and every one on a new connection", () => {
  const server = standIn(() => null);
  const taskRuns = new TaskRuns({ session: server.session, spaces, tasks: runs(true) });
  const heard = vi.fn();
  taskRuns.onWaiting(heard);
  server.send(SOCKET.changed, { organizationId: "org-1", topics: ["task-runs"] });
  server.send(SOCKET.changed, { organizationId: "org-2", topics: ["projects"] });
  server.change("connected");
  expect(heard.mock.calls.map(([spaceId]) => spaceId)).toEqual(["org-1", "org-1", "org-2"]);
});

it("reads the runs waiting in an organization, claims one, and says when this computer has no folder for it", async () => {
  const waiting = {
    run: { id: "run-1", columnId: "c", state: "waiting", runner: { userId: "me", name: "Me" }, requestedAt: "2026-11-26T10:00:00.000Z" },
    task,
    column: { id: "c", name: "Review", job: { prompt: "Review it.", choice: null }, nextColumnName: null },
    fromColumnName: null,
  };
  const server = standIn((_method, path) => {
    if (path === "/task-runs") return [waiting];
    if (path.endsWith("/claim")) return { state: "gone" };
    return { ...waiting.run, state: "no_folder" };
  });
  const taskRuns = new TaskRuns({ session: server.session, spaces, tasks: runs(true) });
  expect((await taskRuns.waiting("org-1")).map((item) => [item.run.id, item.run.requestedAt, item.column.name])).toEqual([["run-1", Date.parse("2026-11-26T10:00:00.000Z"), "Review"]]);
  expect(await taskRuns.claim("org-1", "run-1")).toBe(false);
  await taskRuns.noFolder("org-1", "run-1");
  expect(server.asked.map(({ method, path, body }) => [method, path, (body as { state?: string } | undefined)?.state ?? null])).toEqual([
    ["GET", "/task-runs", null],
    ["POST", "/task-runs/run-1/claim", null],
    ["POST", "/task-runs/run-1/report", "no_folder"],
  ]);
});

it("asks a server that runs no column agents for nothing", async () => {
  const server = standIn(() => []);
  expect(await new TaskRuns({ session: server.session, spaces, tasks: runs(false) }).waiting("org-1")).toEqual([]);
  expect(server.asked).toEqual([]);
});
