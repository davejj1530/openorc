import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { WORKSPACE_ID, type AgentSkill } from "@openorc/protocol";
import { queryClient } from "./query";
import { useSkillCommands } from "./skill-commands";

const rpc = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("./rpc", () => ({ core: { call: rpc.call, onInvalidate: () => {}, onReady: () => {} } }));
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
  const { result } = renderHook(() => useSkillCommands(WORKSPACE_ID, "claude", desk), { wrapper });
  await waitFor(() => expect(result.current).toEqual([{ name: "humanizer", hint: "Rewrite AI-sounding text.", insert: true, prefix: "/" }]));
  expect(rpc.call).toHaveBeenCalledWith("skills.list", { projectId: WORKSPACE_ID, workingDirectory: desk, agent: "claude" });
});

it("offers them as $name on Codex", async () => {
  rpc.call.mockResolvedValue([{ ...humanizer, name: "humanizer:humanizer" }]);
  const { result } = renderHook(() => useSkillCommands(WORKSPACE_ID, "codex", desk), { wrapper });
  await waitFor(() => expect(result.current).toEqual([{ name: "humanizer:humanizer", hint: "Rewrite AI-sounding text.", insert: true, prefix: "$" }]));
  expect(rpc.call).toHaveBeenCalledWith("skills.list", { projectId: WORKSPACE_ID, workingDirectory: desk, agent: "codex" });
});

it("keeps a project's conversations on the project's skills", async () => {
  rpc.call.mockResolvedValue([humanizer]);
  const { result } = renderHook(() => useSkillCommands("project", "claude", "/somewhere/else"), { wrapper });
  await waitFor(() => expect(result.current).toHaveLength(1));
  expect(rpc.call).toHaveBeenCalledWith("skills.list", { projectId: "project", agent: "claude" });
});

it("leaves OpenCode to its own skill tool", () => {
  const { result } = renderHook(() => useSkillCommands(WORKSPACE_ID, "opencode", desk), { wrapper });
  expect(result.current).toEqual([]);
  expect(rpc.call).not.toHaveBeenCalled();
});

it("shows a skill installed while the conversation is open within a minute", async () => {
  vi.useFakeTimers();
  rpc.call.mockResolvedValueOnce([]).mockResolvedValue([humanizer]);
  const { result } = renderHook(() => useSkillCommands(WORKSPACE_ID, "claude", desk), { wrapper });
  await act(() => vi.advanceTimersByTimeAsync(1_000));
  expect(result.current).toEqual([]);

  await act(() => vi.advanceTimersByTimeAsync(60_000));
  expect(result.current.map((command) => command.name)).toEqual(["humanizer"]);
});
