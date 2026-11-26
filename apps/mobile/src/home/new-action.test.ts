import { expect, it, vi } from "vitest";

const pushed = vi.hoisted(() => [] as unknown[]);
vi.mock("expo-router", () => ({ router: { push: (route: unknown) => void pushed.push(route) } }));
vi.mock("../connection/use-shares", () => ({ useShares: () => null }));
vi.mock("../spaces/add-projects", () => ({ useProjectAdding: () => null }));

const { newAction } = await import("./new-action");

it("starts a thread on Threads, a task on Tasks, and offers an Orcling or a thread on Orclings where the Mac makes them", () => {
  const started: string[] = [];
  const newThread = () => void started.push("thread");
  const newTask = () => void started.push("task");
  const threads = newAction("threads", { newThread, newTask, makesOrclings: true, addsTo: null });
  expect(threads).toMatchObject({ kind: "press", label: "New thread" });
  if (threads.kind === "press") threads.onPress();
  expect(started).toEqual(["thread"]);

  const tasks = newAction("tasks", { newThread, newTask, makesOrclings: true, addsTo: null });
  expect(tasks).toMatchObject({ kind: "press", label: "New task" });
  if (tasks.kind === "press") tasks.onPress();
  expect(started).toEqual(["thread", "task"]);

  const orclings = newAction("orclings", { newThread, newTask, makesOrclings: true, addsTo: null });
  expect(orclings.kind === "menu" && orclings.items.map((item) => item.label)).toEqual(["New Orcling", "New Thread"]);
  if (orclings.kind === "menu") orclings.items.forEach((item) => item.onPress());
  expect(pushed).toEqual(["/orcling-new"]);
  expect(started).toEqual(["thread", "task", "thread"]);

  // A Mac that cannot make Orclings for a phone leaves Orclings' New to start a thread.
  expect(newAction("orclings", { newThread, newTask, makesOrclings: false, addsTo: null })).toMatchObject({ kind: "press", label: "New thread" });
});

it("offers a thread or a project on Threads where the phone may add projects to the space, and opens that space's repositories", () => {
  pushed.length = 0;
  const started: string[] = [];
  const starts = { newThread: () => void started.push("thread"), newTask: () => undefined, makesOrclings: false };
  const threads = newAction("threads", { ...starts, addsTo: "org-birch" });
  expect(threads.kind === "menu" && threads.items.map((item) => item.label)).toEqual(["New Thread", "Add Project"]);
  if (threads.kind === "menu") threads.items.forEach((item) => item.onPress());
  expect(started).toEqual(["thread"]);
  expect(pushed).toEqual([{ pathname: "/add-projects", params: { spaceId: "org-birch" } }]);
  // The other tabs start what they did.
  expect(newAction("tasks", { ...starts, addsTo: "org-birch" })).toMatchObject({ kind: "press", label: "New task" });
  expect(newAction("orclings", { ...starts, addsTo: "org-birch" })).toMatchObject({ kind: "press", label: "New thread" });
});
