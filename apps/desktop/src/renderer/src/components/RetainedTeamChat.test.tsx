import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { useThreadTabs } from "../lib/thread-tabs";
import { RetainedTeamChat } from "./RetainedTeamChat";

vi.mock("../views/TeamChatView", () => ({
  TeamChatView: () => {
    const [text, setText] = useState("");
    return <input aria-label="Draft" value={text} onChange={(event) => setText(event.target.value)} />;
  },
}));
const route = { view: "team-chat" as const, accountId: "account", spaceId: "space", conversationId: "chat" };
afterEach(() => {
  cleanup();
  useThreadTabs.setState({ tabs: [], active: null, leaving: [] });
});

it("retains the editor when returning to work and releases it when its tab closes", () => {
  useThreadTabs.setState({ tabs: [{ id: "chat-tab", route }], active: "chat-tab" });
  const view = render(<RetainedTeamChat route={route} />);
  const editor = screen.getByRole("textbox", { name: "Draft" });
  fireEvent.change(editor, { target: { value: "Keep my selection and undo history" } });
  view.rerender(<RetainedTeamChat route={{ view: "newthread" }} />);
  expect(screen.getByRole("textbox", { name: "Draft" })).toBe(editor);
  view.rerender(<RetainedTeamChat route={route} />);
  expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Draft" }).value).toBe("Keep my selection and undo history");
  view.rerender(<RetainedTeamChat route={{ view: "newthread" }} />);
  act(() => useThreadTabs.setState({ tabs: [] }));
  expect(screen.queryByRole("textbox", { name: "Draft" })).toBeNull();
});
