import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { WORKSPACE_ID, type AgentSkill } from "@openorc/protocol";
import { queryClient } from "./client";
import { projectScope, useSkillCommands } from "./skill-commands";

const rpc = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("./rpc", () => ({ core: { call: rpc.call, onReady: () => {}, onPush: () => () => {} } }));
const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;

/** Rini's own conversation works in its folder, not in a project. */
const desk = "/data/orclings/rini";
const humanizer: AgentSkill = { name: "humanizer", description: "Rewrite AI-sounding text.", source: "user", path: "/home/.claude/skills/humanizer/SKILL.md" };

afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.resetAllMocks();
  vi.useRealTimers();
});

it("offers an Orcling's skills from the folder its conversation works in, as /name on Claude", async () => {
  rpc.call.mockResolvedValue([humanizer]);
  const { result } = renderHook(() => useSkillCommands(projectScope(WORKSPACE_ID, desk), "claude"), { wrapper });
  await waitFor(() => expect(result.current.commands).toEqual([{ name: "humanizer", hint: "Rewrite AI-sounding text.", insert: true, prefix: "/" }]));
  expect(rpc.call).toHaveBeenCalledWith("skills.list", { scope: { kind: "project", id: WORKSPACE_ID, workingDirectory: desk }, agent: "claude" });
});

it("offers them as $name on Codex", async () => {
  rpc.call.mockResolvedValue([{ ...humanizer, name: "humanizer:humanizer" }]);
  const { result } = renderHook(() => useSkillCommands(projectScope(WORKSPACE_ID, desk), "codex"), { wrapper });
  await waitFor(() => expect(result.current.commands).toEqual([{ name: "humanizer:humanizer", hint: "Rewrite AI-sounding text.", insert: true, prefix: "$" }]));
  expect(rpc.call).toHaveBeenCalledWith("skills.list", { scope: { kind: "project", id: WORKSPACE_ID, workingDirectory: desk }, agent: "codex" });
});

it("keeps a project's conversations on the project's skills", async () => {
  rpc.call.mockResolvedValue([humanizer]);
  const { result } = renderHook(() => useSkillCommands(projectScope("project", "/somewhere/else"), "claude"), { wrapper });
  await waitFor(() => expect(result.current.commands).toHaveLength(1));
  expect(rpc.call).toHaveBeenCalledWith("skills.list", { scope: { kind: "project", id: "project" }, agent: "claude" });
});

it("reads a conversation's skills from the folder it works in, a worktree's own branch included", async () => {
  rpc.call.mockResolvedValue([humanizer]);
  const { result } = renderHook(() => useSkillCommands({ kind: "thread", id: "t1" }, "claude"), { wrapper });
  await waitFor(() => expect(result.current.commands).toHaveLength(1));
  expect(rpc.call).toHaveBeenCalledWith("skills.list", { scope: { kind: "thread", id: "t1" }, agent: "claude" });
});

it("offers the project's own skills ahead of personal and plugin ones", async () => {
  rpc.call.mockResolvedValue([
    { ...humanizer, name: "anatomy" },
    { ...humanizer, name: "brag:brag", source: "plugin" },
    { ...humanizer, name: "fix-bug", source: "project" },
    { ...humanizer, name: "terraform", source: "project" },
  ]);
  const { result } = renderHook(() => useSkillCommands(projectScope("project"), "claude"), { wrapper });
  await waitFor(() => expect(result.current.commands.map((command) => command.name)).toEqual(["fix-bug", "terraform", "anatomy", "brag:brag"]));
});

it("leaves OpenCode to its own skill tool", () => {
  const { result } = renderHook(() => useSkillCommands(projectScope(WORKSPACE_ID, desk), "opencode"), { wrapper });
  expect(result.current.commands).toEqual([]);
  expect(rpc.call).not.toHaveBeenCalled();
});

it("reads the list again when the picker opens, not on a timer, and not twice in a few seconds", async () => {
  vi.useFakeTimers();
  rpc.call.mockResolvedValueOnce([]).mockResolvedValue([humanizer]);
  const { result } = renderHook(() => useSkillCommands(projectScope(WORKSPACE_ID, desk), "claude"), { wrapper });
  await act(() => vi.advanceTimersByTimeAsync(1_000));
  expect(result.current.commands).toEqual([]);

  act(() => result.current.onCommandsWanted());
  await act(() => vi.advanceTimersByTimeAsync(1_000));
  expect(rpc.call).toHaveBeenCalledTimes(1);

  await act(() => vi.advanceTimersByTimeAsync(10 * 60_000));
  expect(rpc.call).toHaveBeenCalledTimes(1);
  expect(result.current.commands).toEqual([]);

  act(() => result.current.onCommandsWanted());
  await act(() => vi.advanceTimersByTimeAsync(1_000));
  expect(rpc.call).toHaveBeenCalledTimes(2);
  expect(result.current.commands.map((command) => command.name)).toEqual(["humanizer"]);
});

it("says while there are no skills yet that they are loading or why they could not be, and keeps offering a list read before when reading it again fails", async () => {
  rpc.call.mockRejectedValue(new Error("/code/project is missing. It may have been moved or deleted."));
  const failing = renderHook(() => useSkillCommands(projectScope("project"), "codex"), { wrapper });
  expect(failing.result.current.commandsNotice).toEqual({ prefix: "$", text: "Loading skills…" });
  await waitFor(() => expect(failing.result.current.commandsNotice).toEqual({ prefix: "$", text: "Couldn’t load skills", reason: "/code/project is missing. It may have been moved or deleted." }), {
    timeout: 5_000,
  });
  act(() => failing.result.current.onCommandsWanted());
  await waitFor(() => expect(failing.result.current.commandsNotice).toEqual({ prefix: "$", text: "Loading skills…" }));
  failing.unmount();
  queryClient.clear();
  rpc.call.mockReset();

  vi.useFakeTimers();
  rpc.call.mockResolvedValueOnce([humanizer]).mockRejectedValue(new Error("gone"));
  const { result } = renderHook(() => useSkillCommands(projectScope("project"), "claude"), { wrapper });
  await act(() => vi.advanceTimersByTimeAsync(1_000));
  await act(() => vi.advanceTimersByTimeAsync(60_000));
  act(() => result.current.onCommandsWanted());
  await act(() => vi.advanceTimersByTimeAsync(10_000));
  expect(rpc.call).toHaveBeenCalledTimes(3);
  expect(result.current.commands.map((command) => command.name)).toEqual(["humanizer"]);
  expect(result.current.commandsNotice).toBeNull();
});
