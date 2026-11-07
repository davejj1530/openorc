import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Project, ThreadSummary } from "@openorc/protocol";
import { useLayout } from "../lib/layout";
import { ThreadMedia, ThreadLink, ThreadRichText, type MediaScope } from "./ThreadImages";
import { useRunVoice } from "../lib/turn-authors";
import { SubagentConversation } from "./SubagentConversation";

const rows = vi.hoisted(() => ({ parent: null as ThreadSummary | null }));
vi.mock("../lib/client", () => ({
  useRpc: (method: string) => {
    if (method === "threads.get") return { data: rows.parent };
    return {
      data:
        method === "agents.models"
          ? [{ agent: "opencode", id: "opencode/deepseek-v4.1-flash-free", label: "DeepSeek V4.1 Flash Free" }]
          : [{ id: "run", agent: "opencode", model: "opencode/deepseek-v4.1-flash-free" }],
    };
  },
  useRpcMutation: () => ({}),
  useConversationTranscript: () => ({ merged: {} }),
}));
vi.mock("./Transcript", () => ({
  Transcript: ({ media }: { media: MediaScope }) => (
    <ThreadMedia scopeKey="child" {...media}>
      <ThreadLink href="/repo/README.md">README.md</ThreadLink>
      <ThreadRichText>{"See [the footer](src/footer.tsx:12)."}</ThreadRichText>
      <span>{useRunVoice("run")?.model}</span>
    </ThreadMedia>
  ),
}));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  rows.parent = null;
});
it("reveals a child's file link in its folder without opening a hidden child panel", () => {
  const revealFile = vi.fn();
  vi.stubGlobal("openorc", { revealFile });
  useLayout.setState({ selectedFile: null, panelOpen: false });
  render(<SubagentConversation thread={{ id: "child", agent: "claude", model: "haiku" } as ThreadSummary} project={{ rootPath: "/repo" } as Project} />);
  fireEvent.click(screen.getByRole("link", { name: "README.md" }));
  expect(revealFile).toHaveBeenCalledExactlyOnceWith("/repo/README.md");
  expect(useLayout.getState()).toMatchObject({ selectedFile: null, panelOpen: false });
});

it("uses the model catalog label in both the child turn heading and status bar", () => {
  render(<SubagentConversation thread={{ id: "child", agent: "opencode", model: "opencode/deepseek-v4.1-flash-free" } as ThreadSummary} project={{ rootPath: "/repo" } as Project} />);
  expect(screen.getAllByText("DeepSeek V4.1 Flash Free")).toHaveLength(2);
  expect(screen.queryByText("opencode/deepseek-v4.1-flash-free")).toBeNull();
});

it("opens a cloud subagent's file links in its parent's copy on this Mac, and reads them as references without one", async () => {
  const revealFile = vi.fn();
  vi.stubGlobal("openorc", { revealFile });
  const cloud = { brain: "cloud", reach: "live", heardAt: 1 } as const;
  const child = { id: "child", agent: "claude", model: "haiku", parentThreadId: "parent", workingDirectory: "/vercel/sandbox/repo", owner: cloud } as ThreadSummary;
  rows.parent = { id: "parent", worktreePath: null, owner: cloud } as ThreadSummary;
  render(<SubagentConversation thread={child} project={{ rootPath: "/repo" } as Project} />);
  const reference = await screen.findByText("the footer");
  expect(reference.closest("a")).toBeNull();
  fireEvent.click(reference);
  expect(revealFile).not.toHaveBeenCalled();
  cleanup();
  rows.parent = { id: "parent", worktreePath: "/mirrors/footer", owner: { ...cloud, mirror: true } } as ThreadSummary;
  render(<SubagentConversation thread={child} project={{ rootPath: "/repo" } as Project} />);
  fireEvent.click(await screen.findByText("the footer"));
  expect(revealFile).toHaveBeenCalledExactlyOnceWith("/mirrors/footer/src/footer.tsx");
});
