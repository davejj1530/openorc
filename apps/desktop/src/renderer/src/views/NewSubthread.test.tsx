import type { Thread } from "@openorc/protocol";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useRouter } from "../lib/router";

const start = vi.fn();
const parent = {
  id: "home",
  projectId: "p1",
  title: "Landing page",
  agent: "codex",
  model: "codex-model",
  effort: "high",
  fastMode: false,
  mode: "act",
  permissionMode: "trusted",
  claudeAccountId: null,
  workingDirectory: null,
  worktreePath: "/worktrees/landing",
  branch: "openorc/landing",
} as unknown as Thread;

vi.mock("../lib/client", async (original) => ({
  ...(await original<object>()),
  useRpc: (method: string) => ({ data: method === "threads.get" ? parent : undefined, error: null, isPending: false, refetch: vi.fn() }),
  useRpcMutation: () => ({ mutateAsync: start, reset: vi.fn(), isPending: false, error: null }),
}));
vi.mock("../lib/rpc", () => ({ core: { call: async () => null, onReady: () => () => {}, onPush: () => () => {} } }));
vi.mock("../lib/skill-commands", () => ({ useSkillCommands: () => [] }));
vi.mock("../components/TopBar", () => ({ TopBar: ({ children }: { children: React.ReactNode }) => <header>{children}</header> }));
vi.mock("../components/ModelPicker", () => ({
  ModelPicker: () => <button type="button">Choose model</button>,
  ComposerModelPicker: () => <button type="button">Choose model</button>,
}));

import { NewSubthread } from "./NewSubthread";

beforeEach(() => {
  localStorage.clear();
  start.mockReset().mockResolvedValue({ thread: { id: "sub-1" }, run: null });
  useRouter.getState().navigate({ view: "newsubthread", parentId: "home" });
});
afterEach(cleanup);

it("starts the subthread under its parent on the parent's settings, then opens it", async () => {
  render(
    <StrictMode>
      <NewSubthread parentId="home" />
    </StrictMode>,
  );
  expect(screen.getByRole("heading").textContent).toBe("What should we work on under Landing page?");
  const message = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Message" });
  fireEvent.change(message, { target: { value: "Fix the flaky signup test" } });
  fireEvent.keyDown(message, { key: "Enter", code: "Enter" });
  await waitFor(() => expect(useRouter.getState().route).toEqual({ view: "thread", threadId: "sub-1" }));
  expect(start).toHaveBeenCalledWith({
    projectId: "p1",
    parentThreadId: "home",
    agent: "codex",
    model: "codex-model",
    effort: "high",
    fastMode: false,
    mode: "act",
    permissionMode: "trusted",
    prompt: "Fix the flaky signup test",
    attachments: [],
  });
  expect(localStorage.getItem("openorc.draft.subthread.home")).toBe(JSON.stringify({ prompt: "" }));
});
