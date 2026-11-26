import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { TeamConversation, TeamMessage } from "@openorc/protocol";
import { lastDisplayed } from "../lib/team-chat-seen";
import { messageOf, type } from "./composer-editor/testing";
import { SidebarTeamChatRow } from "./SidebarTeamChatRow";
import { TeamChatComposer } from "./TeamChatComposer";
import { TeamChatMessage } from "./TeamChatMessage";
import { TeamChatTranscript } from "./TeamChatTranscript";

const robin = { id: "u-1", name: "Robin Patel", image: null };
const casey = { id: "u-2", name: "Casey Morgan", image: null };
const message = (seq: number, body: string, from = robin): TeamMessage => ({
  id: `m-${seq}`,
  channelId: "c",
  seq,
  actor: { kind: "person", person: from },
  body,
  files: [],
  reactions: [],
  replyTo: null,
  pinned: null,
  call: null,
  createdAt: new Date(Date.UTC(2026, 0, 1, 0, seq)).toISOString(),
});
const conversation: TeamConversation = {
  id: "c",
  kind: "channel",
  name: "general",
  topic: null,
  private: false,
  members: [robin],
  joined: true,
  createdAt: new Date(0).toISOString(),
  lastMessageAt: null,
  lastMessageSeq: 3,
  read: { seenSeq: 0, seenThroughMessageId: null, unread: 3, hasMention: true },
  canAddMembers: true,
  canRemoveMembers: false,
  participants: null,
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("counts a message once its trailing edge is in view, never one below the fold", () => {
  const edges: Record<string, number | null> = { a: 120, b: 399, c: 402, gone: null };
  const shown = lastDisplayed(
    ["a", "b", "c", "gone"].map((id, index) => ({ id, seq: index + 1 })),
    { top: 0, bottom: 400 },
    (id) => edges[id] ?? null,
  );
  expect(shown?.id).toBe("b");
  expect(lastDisplayed([{ id: "a", seq: 1 }], { top: 200, bottom: 400 }, () => 150)).toBeNull();
});

it("reports what is displayed only while the window is focused, and draws New messages before the first unread", () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  let focused = false;
  vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
  const bottoms: Record<string, number> = { "m-1": 100, "m-2": 300, "m-3": 700 };
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const row = this.closest<HTMLElement>("[data-message-id]");
    const bottom = row ? (bottoms[row.dataset["messageId"]!] ?? 0) : 400;
    return { top: row ? bottom - 40 : 0, bottom, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  });
  const onShown = vi.fn();
  const view = render(
    <TeamChatTranscript
      conversationId="general"
      messages={[message(1, "First"), message(2, "Second"), message(3, "Third")]}
      pending={[]}
      self="self"
      people={[robin]}
      names
      reason={null}
      older={false}
      loadingOlder={false}
      onOlder={() => {}}
      onReact={() => {}}
      onRetry={() => {}}
      newFrom={1}
      onShown={onShown}
    />,
  );
  const line = view.container.querySelector(".team-chat-new");
  expect(line?.textContent).toBe("New messages");
  expect(line?.nextElementSibling?.textContent).toContain("Second");
  expect(onShown).not.toHaveBeenCalled();
  focused = true;
  act(() => {
    window.dispatchEvent(new Event("focus"));
  });
  expect(onShown).toHaveBeenLastCalledWith(expect.objectContaining({ id: "m-2" }));
  bottoms["m-3"] = 380;
  fireEvent.scroll(view.container.querySelector(".team-chat-scroll")!);
  expect(onShown).toHaveBeenLastCalledWith(expect.objectContaining({ id: "m-3" }));
  const calls = onShown.mock.calls.length;
  focused = false;
  act(() => {
    window.dispatchEvent(new Event("blur"));
  });
  bottoms["m-3"] = 200;
  fireEvent.scroll(view.container.querySelector(".team-chat-scroll")!);
  expect(onShown).toHaveBeenCalledTimes(calls);
});

it("shows a neutral count after the mention mark only when the server keeps read places", () => {
  const row = { kind: "conversation" as const, id: "c", title: "general", conversation };
  const view = render(<SidebarTeamChatRow row={row} self="self" selected={null} pending={false} onOpen={() => {}} unread />);
  expect(view.container.querySelector(".sidebar-chat-count")?.textContent).toBe("3");
  expect(screen.getByText("3 unread, mentions you")).toBeTruthy();
  expect(view.container.querySelector(".sidebar-chat-row-unread")).toBeTruthy();
  cleanup();
  const off = render(<SidebarTeamChatRow row={row} self="self" selected={null} pending={false} onOpen={() => {}} />);
  expect(off.container.querySelector(".sidebar-chat-marks")).toBeNull();
  expect(off.container.querySelector(".sidebar-chat-row-unread")).toBeNull();
});

it("tags a person picked from the list as their identity and draws their first name", async () => {
  const changes: string[] = [];
  function Harness() {
    const [text, setText] = useState("");
    return (
      <TeamChatComposer
        text={text}
        placeholder="Message #general…"
        reason={null}
        onChange={(next) => {
          changes.push(next);
          setText(next);
        }}
        onSend={() => {}}
        taggable={[robin, casey]}
        named={[robin, casey]}
      />
    );
  }
  render(<Harness />);
  const field = await screen.findByRole("textbox");
  type(field, "Hi @ro");
  expect(await screen.findByRole("option", { name: "Robin Patel" })).toBeTruthy();
  expect(screen.queryByRole("option", { name: "Casey Morgan" })).toBeNull();
  fireEvent.keyDown(field, { key: "Enter" });
  await waitFor(() => expect(messageOf(field)).toBe("Hi @[user:u-1] "));
  expect(field.querySelector(".person-token")?.textContent).toBe("@Robin");
  expect(screen.queryByRole("option")).toBeNull();
  type(field, "Hi @[user:u-1] and @Casey typed by hand");
  expect(field.querySelectorAll(".person-token")).toHaveLength(1);
});

it("draws a sent tag as the person's full name and copies names, never tokens", async () => {
  const writeText = vi.fn(async () => {});
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
  const odd = { id: "user-robin@example.com", name: "Robin Lee", image: null };
  const linked = render(<TeamChatMessage message={message(5, `@[user:${odd.id}] and *@[user:${robin.id}]*`, casey)} self="self" people={[robin, odd]} reason={null} onReact={() => {}} />);
  await waitFor(() => expect([...linked.container.querySelectorAll(".person-token")].map((mark) => mark.textContent)).toEqual(["@Robin Lee", "@Robin Patel"]));
  expect(linked.container.querySelector("a")).toBeNull();
  cleanup();
  const view = render(
    <TeamChatMessage message={message(4, `@[user:${robin.id}] can you check the **notes**? @[user:gone]`, casey)} self="self" people={[robin, casey]} reason={null} onReact={() => {}} />,
  );
  await waitFor(() => expect(view.container.querySelector(".person-token")?.textContent).toBe("@Robin Patel"));
  expect(view.container.querySelector('[data-streamdown="strong"]')?.textContent).toBe("notes");
  expect(view.container.textContent).not.toContain("@[user:");
  fireEvent.contextMenu(view.container.querySelector(".orcling-bubble")!);
  fireEvent.click(await screen.findByRole("menuitem", { name: "Copy text" }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith("@Robin Patel can you check the **notes**? @Former member"));
});
