// @vitest-environment jsdom
import type { Block } from "@openorc/client";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { FakeMac } from "../test-fixtures/fake-mac";

const pushed = vi.hoisted(() => [] as unknown[]);
vi.mock("expo-router", () => ({ router: { push: (route: unknown) => void pushed.push(route) } }));
const mac = vi.hoisted(() => ({ phone: null as FakeMac | null, tasks: true }));
vi.mock("../client", async () => {
  const { fakeMac } = await import("../test-fixtures/fake-mac");
  mac.phone = fakeMac(async (method, params) => {
    const { id } = params as { id: string };
    if (method === "tasks.get") {
      if (!mac.tasks) throw new Error("Update OpenOrc on your Mac to open its tasks here.");
      return { id, title: "Add a retry", status: "in_progress" };
    }
    if (method === "threads.get") return { id, title: "Check the docs", activity: "waiting" };
    throw new Error(`no ${method}`);
  });
  return mac.phone.module;
});

const { ToolCard } = await import("./work-cards");

const tool = (name: string, output: string): Extract<Block, { kind: "tool" }> =>
  ({ id: `tool-${name}`, kind: "tool", name, input: {}, output, done: true, isError: false, runId: "r1" }) as Extract<Block, { kind: "tool" }>;
const taskId = "0b6b9d4e-6a51-4a4b-9c38-2d4f1a6b7c8d";

afterEach(() => {
  cleanup();
  pushed.length = 0;
  mac.tasks = true;
  mac.phone!.module.queryClient.clear();
});

it("shows a task the agent saved as a card that opens the task", async () => {
  render(<ToolCard block={tool("openorc_task_create", `{"task":{"id":"${taskId}"}}`)} runId="r1" />, { wrapper: mac.phone!.wrapper });
  fireEvent.click(await screen.findByRole("button", { name: "Add a retry, Task · In progress" }));
  expect(pushed).toEqual([{ pathname: "/task/[id]", params: { id: taskId } }]);
});

it("shows a thread the agent started as a subthread card that opens it", async () => {
  render(<ToolCard block={tool("openorc_thread_start", JSON.stringify({ thread: { id: "child-1" } }))} runId="r1" />, { wrapper: mac.phone!.wrapper });
  fireEvent.click(await screen.findByRole("button", { name: "Check the docs, Subthread · Needs you" }));
  expect(pushed).toEqual([{ pathname: "/thread/[id]", params: { id: "child-1" } }]);
});

it("keeps the call's own row on a Mac that cannot open tasks", { timeout: 6_000 }, async () => {
  mac.tasks = false;
  render(<ToolCard block={tool("openorc_task_create", `{"task":{"id":"${taskId}"}}`)} runId="r1" />, { wrapper: mac.phone!.wrapper });
  // The read is tried once more before the card gives way to the row.
  await vi.waitFor(() => expect(document.body.textContent).not.toBe(""), { timeout: 4_000 });
  expect(screen.queryByRole("button", { name: /Add a retry/ })).toBeNull();
});
