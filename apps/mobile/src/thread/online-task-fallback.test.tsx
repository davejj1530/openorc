// @vitest-environment jsdom
import type { Block } from "@openorc/client";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { FakeMac } from "../test-fixtures/fake-mac";

const calls = vi.hoisted(() => [] as string[]);
const phone = vi.hoisted(() => ({ current: null as FakeMac | null }));
vi.mock("expo-router", () => ({ router: { push: vi.fn() } }));
vi.mock("../client", async () => {
  const { fakeMac } = await import("../test-fixtures/fake-mac");
  phone.current = fakeMac(async (method) => {
    calls.push(method);
    if (method === "tasks.get") return null;
    throw new Error(`Unexpected phone call: ${method}`);
  });
  return phone.current.module;
});
const { ToolCard } = await import("./work-cards");
afterEach(() => {
  cleanup();
  calls.length = 0;
  phone.current?.module.queryClient.clear();
});

it("ignores the server reference and keeps the tool row when its legacy Mac task read has no record", async () => {
  const id = "41c0591f-e6ae-4f8b-b3ac-a6b55b99cc32";
  const block: Extract<Block, { kind: "tool" }> = {
    id: "create-task",
    kind: "tool",
    name: "openorc_task_create",
    input: {},
    done: true,
    isError: false,
    output: JSON.stringify({ id, title: "Prepare the export", taskRef: { place: "server", spaceId: "org:fixture", projectId: "shared-project", id } }),
  };
  render(<ToolCard block={block} runId="run-one" />, { wrapper: phone.current!.wrapper });
  await waitFor(() => expect(calls).toContain("tasks.get"));
  await waitFor(() => expect(document.body.textContent).not.toBe(""));
  expect(screen.queryByRole("button", { name: /Prepare the export, Task/ })).toBeNull();
  expect(calls.every((method) => method === "tasks.get")).toBe(true);
});
