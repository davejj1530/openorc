import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { emptyRun, type Block } from "@openorc/client";
import { defaultOrclingLook, type Orcling } from "@openorc/protocol";

const { state } = vi.hoisted(() => ({
  state: {
    orclings: [] as Orcling[],
    chats: new Map<string, { unread: boolean; lastActivityAt: number; seenAt: number | null }>(),
    blocks: [] as Block[],
    updates: [] as unknown[],
    sent: [] as unknown[],
  },
}));
vi.mock("../lib/client", async (original) => {
  const thread = (id: string) => {
    const chat = state.chats.get(id);
    return chat ? { id, projectId: "workspace", activity: "idle", owner: null, draft: null, session: null, ...chat } : null;
  };
  return {
    ...(await original<object>()),
    useRpc: (method: string) => ({
      data: ({ "orclings.list": state.orclings, "agents.models": [{ agent: "claude", id: "opus", label: "Opus 5.5" }] } as Record<string, unknown>)[method] ?? [],
      isLoading: false,
      error: null,
    }),
    useRpcs: (_method: string, params: { id: string }[]) => params.map(({ id }) => ({ data: thread(id) })),
    useRpcMutation: () => ({ mutate: (params: unknown) => state.updates.push(params) }),
    useConversationTranscript: () => ({ merged: { ...emptyRun("run"), blocks: state.blocks, blockIndex: new Map() } }),
    useConversationSettings: () => ({ choice: { agent: "claude", model: "opus", effort: null }, mode: "act", permission: "trusted", permissionReady: true, waitForSave: async () => {} }),
    useSubmit: () => ({ submit: async (_request: unknown, message: unknown) => (state.sent.push(message), "start"), pending: false, error: null }),
  };
});
vi.mock("./ui", async (importOriginal) => ({ ...(await importOriginal<typeof import("./ui")>()), Tooltip: ({ children }: { children: ReactNode }) => children }));
vi.mock("./ThreadImages", () => ({ ThreadRichText: ({ children }: { children: string }) => <p>{children}</p> }));
vi.mock("./UserMessage", () => ({ UserMessage: ({ text }: { text: string }) => <div data-testid="mine">{text}</div> }));
vi.mock("./Composer", () => ({
  Composer: ({ placeholder, onSubmit }: { placeholder: string; onSubmit: (text: string, files: string[], now: boolean) => Promise<void> }) => (
    <button type="button" onClick={() => void onSubmit("Yes. Tell me when it passes.", [], true)}>
      {placeholder}
    </button>
  ),
}));

import { HeaderOrcling } from "./HeaderOrcling";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  state.orclings = [];
  state.chats.clear();
  state.blocks = [];
  state.updates.length = 0;
  state.sent.length = 0;
});

const orcling = (name: string): Orcling => ({
  id: name,
  name,
  look: defaultOrclingLook,
  settings: { agent: "claude", model: "opus", effort: null, fastMode: false },
  permission: "allow",
  claudeAccountId: "claude-cli",
  threadId: `${name}-chat`,
  wakes: [],
  createdAt: 1,
  updatedAt: 1,
});
const said = (id: string, role: "user" | "assistant", text: string): Block => ({ id, kind: "message", role, text, streaming: false, at: 1, runId: "run" });

it("draws nothing without an Orcling", () => {
  const { container } = render(<HeaderOrcling />);
  expect(container.innerHTML).toBe("");
});

it("shows the Orcling with the newest unread message, with the unread dot, and only her face", () => {
  state.orclings = [orcling("Atlas"), orcling("Rini")];
  state.chats.set("Atlas-chat", { unread: false, lastActivityAt: 9, seenAt: 9 });
  state.chats.set("Rini-chat", { unread: true, lastActivityAt: 5, seenAt: 1 });
  render(<HeaderOrcling />);
  const face = screen.getByRole("button", { name: "Chat with Rini" });
  expect(face.querySelector('[data-mark="unread"]')).not.toBeNull();
  expect(face.textContent).toBe("");
});

it("opens her small chat only on a press, reads it, sends as her chat does, and closes on Escape back to her face", async () => {
  state.orclings = [orcling("Rini")];
  state.chats.set("Rini-chat", { unread: true, lastActivityAt: 5, seenAt: 1 });
  state.blocks = [said("a1", "assistant", "The hero failed on its Astro build. Want it run again on Codex?")];
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  render(<HeaderOrcling />);
  expect(screen.queryByRole("dialog")).toBeNull();
  const face = screen.getByRole("button", { name: "Chat with Rini" });
  fireEvent.click(face);

  const chat = await screen.findByRole("dialog", { name: "Chat with Rini" });
  expect(chat.textContent).toContain("RiniOpus 5.5");
  expect(chat.textContent).toContain("Want it run again on Codex?");
  expect(state.updates).toContainEqual({ id: "Rini-chat", patch: { seen: true } });

  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Message Rini…" })));
  expect(state.sent).toEqual([expect.objectContaining({ text: "Yes. Tell me when it passes.", attachments: [] })]);
  expect(screen.getByTestId("mine").textContent).toBe("Yes. Tell me when it passes.");

  fireEvent.keyDown(chat, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(document.activeElement).toBe(face);
});
