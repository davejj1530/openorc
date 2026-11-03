import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Project, ThreadSummary } from "@openorc/protocol";
import type { FileSelection } from "../lib/layout";
import { useLayout } from "../lib/layout";
import { ThreadMedia, ThreadLink } from "./ThreadImages";
import { useRunVoice } from "../lib/turn-authors";
import { SubagentConversation } from "./SubagentConversation";

vi.mock("../lib/client", () => ({
  useRpc: (method: string) => ({
    data:
      method === "agents.models"
        ? [{ agent: "opencode", id: "opencode/deepseek-v4.1-flash-free", label: "DeepSeek V4.1 Flash Free" }]
        : [{ id: "run", agent: "opencode", model: "opencode/deepseek-v4.1-flash-free" }],
  }),
  useRpcMutation: () => ({}),
  useConversationTranscript: () => ({ merged: {} }),
}));
vi.mock("./Transcript", () => ({
  Transcript: ({ basePath, fileScope }: { basePath: string; fileScope?: FileSelection["scope"] }) => (
    <ThreadMedia scopeKey="child" basePath={basePath} fileScope={fileScope}>
      <ThreadLink href="/repo/README.md">README.md</ThreadLink>
      <span>{useRunVoice("run")?.model}</span>
    </ThreadMedia>
  ),
}));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
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
