// @vitest-environment jsdom
import type { ReactNode } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ChatComposer } from "./ChatComposer";

const chat = vi.hoisted(() => ({ text: "", write: vi.fn(), call: vi.fn() }));
const PIP = { localOrclingId: "o1", name: "Pip", look: {} };
const RINI = { localOrclingId: "o2", name: "Rini", look: {} };
vi.mock("../client", () => ({
  teamChat: {
    useDraft: () => ({ text: chat.text, replyTo: null }),
    useOrclingPicks: (enabled: boolean) => (enabled ? [PIP, RINI] : []),
    drafts: { write: chat.write, callOrcling: chat.call, reply: vi.fn() },
  },
}));
vi.mock("react-native-keyboard-controller", () => ({ KeyboardStickyView: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock("../orclings/OrclingFace", () => ({ OrclingFace: () => null }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const target = { accountId: "u-riley", spaceId: "org-birch", conversationId: "c-launch" };
const show = (orclings: boolean) => render(<ChatComposer target={target} title="#launch" failure={null} self="u-riley" orclings={orclings} onSend={vi.fn()} onFocus={vi.fn()} />);

it("offers the reader's Orclings whose names answer the @ word, and a pick calls one by its name in the words", () => {
  chat.text = "can you check @pi";
  show(true);
  expect(screen.queryByRole("button", { name: "Call Rini" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Call Pip" }));
  expect(chat.write).toHaveBeenCalledWith(target, "can you check @Pip ");
  expect(chat.call).toHaveBeenCalledWith(target, PIP);
});

it("offers none without an @ word, or where the organization's chat takes no Orclings", () => {
  chat.text = "plain words";
  show(true);
  expect(screen.queryByRole("button", { name: /^Call / })).toBeNull();
  cleanup();
  chat.text = "@";
  show(false);
  expect(screen.queryByRole("button", { name: /^Call / })).toBeNull();
});
