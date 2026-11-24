import { expect, it, vi } from "vitest";

const pushed = vi.hoisted(() => [] as unknown[]);
vi.mock("expo-router", () => ({ router: { push: (route: unknown) => void pushed.push(route) } }));
vi.mock("../connection/use-shares", () => ({ useShares: () => null }));

const { newAction } = await import("./new-action");

it("starts a thread on Threads, a task on Tasks, and offers an Orcling or a thread on Orclings where the Mac makes them", () => {
  const started: string[] = [];
  const newThread = () => void started.push("thread");
  const newTask = () => void started.push("task");
  const threads = newAction("threads", { newThread, newTask, makesOrclings: true });
  expect(threads).toMatchObject({ kind: "press", label: "New thread" });
  if (threads.kind === "press") threads.onPress();
  expect(started).toEqual(["thread"]);

  const tasks = newAction("tasks", { newThread, newTask, makesOrclings: true });
  expect(tasks).toMatchObject({ kind: "press", label: "New task" });
  if (tasks.kind === "press") tasks.onPress();
  expect(started).toEqual(["thread", "task"]);

  const orclings = newAction("orclings", { newThread, newTask, makesOrclings: true });
  expect(orclings.kind === "menu" && orclings.items.map((item) => item.label)).toEqual(["New Orcling", "New Thread"]);
  if (orclings.kind === "menu") orclings.items.forEach((item) => item.onPress());
  expect(pushed).toEqual(["/orcling-new"]);
  expect(started).toEqual(["thread", "task", "thread"]);

  // A Mac that cannot make Orclings for a phone leaves Orclings' New to start a thread.
  expect(newAction("orclings", { newThread, newTask, makesOrclings: false })).toMatchObject({ kind: "press", label: "New thread" });
});
