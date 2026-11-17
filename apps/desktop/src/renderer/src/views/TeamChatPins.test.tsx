import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { RpcParams, TeamChatPins, TeamChatStatus, TeamChatTimeline, TeamConversation, TeamMessage } from "@openorc/protocol";
import { core } from "../lib/rpc";
import { queryClient } from "../lib/client";
import { TeamChatContext, type TeamChatContextValue } from "../lib/team-chat-context";
import { teamChatDrafts } from "../lib/team-chat-queries";
import { TeamChatVisibility } from "../lib/team-chat-visibility";
import { TeamChatView } from "./TeamChatView";

vi.mock("../components/TopBar", () => ({ TopBar: ({ children }: { children: ReactNode }) => <header>{children}</header> }));
vi.mock("../components/ThreadTabs", () => ({ ThreadTabs: () => <span>Chat</span> }));
vi.mock("../components/ThreadImages", () => ({ ThreadRichText: ({ children }: { children: ReactNode }) => <span>{children}</span> }));
const target = { view: "team-chat" as const, accountId: "self", spaceId: "team", conversationId: "general" };
const self = { id: "self", name: "Alex Chen", image: null };
const mara = { id: "mara", name: "Mara Okafor", image: null };
const conversation: TeamConversation = {
  id: "general",
  kind: "channel",
  name: "general",
  topic: null,
  private: false,
  members: [self, mara],
  joined: true,
  lastMessageAt: null,
  canAddMembers: false,
  canRemoveMembers: false,
  createdAt: new Date(0).toISOString(),
  participants: null,
  lastMessageSeq: 0,
  read: null,
};
const message = (seq: number, body: string, by = mara, replyTo: TeamMessage["replyTo"] = null): TeamMessage => ({
  id: `m${seq}`,
  channelId: "general",
  seq,
  actor: { kind: "person", person: by },
  body,
  files: [],
  reactions: [],
  replyTo,
  pinned: null,
  call: null,
  createdAt: new Date(seq * 60_000).toISOString(),
});
const status = (features: string[]): TeamChatStatus => ({
  state: "ready",
  accountId: "self",
  spaceId: "team",
  reach: "live",
  chat: { features: features as never, people: [self, mara], conversations: [conversation] },
});
const context = (): TeamChatContextValue => ({ ...target, generation: 1, reach: "live", current: () => true });
const tree = () => (
  <QueryClientProvider client={queryClient}>
    <TeamChatContext value={context()}>
      <TeamChatVisibility value>
        <TeamChatView target={target} />
      </TeamChatVisibility>
    </TeamChatContext>
  </QueryClientProvider>
);
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  teamChatDrafts.forget(target);
  localStorage.clear();
  vi.restoreAllMocks();
});

function serve(
  features: string[],
  pages: (params: RpcParams<"teamChat.timeline">) => TeamChatTimeline,
  pinsPage: (params: RpcParams<"teamChat.pins">) => TeamChatPins | Promise<TeamChatPins> = () => ({ pins: [] }),
) {
  return vi.spyOn(core, "call").mockImplementation(async (method, params) => {
    if (method === "teamChat.state") return status(features);
    if (method === "teamChat.timeline") return pages(params as RpcParams<"teamChat.timeline">);
    if (method === "teamChat.pins") return pinsPage(params as RpcParams<"teamChat.pins">);
    if (method === "teamChat.pin") {
      const asked = params as RpcParams<"teamChat.pin">;
      return { ...message(2, "Is the build green?"), pinned: asked.pinned ? { by: self, at: new Date().toISOString() } : null };
    }
    if (method === "teamChat.send") {
      const sent = params as RpcParams<"teamChat.send">;
      return { ...message(3, sent.body, self, sent.replyToId ? { id: sent.replyToId, seq: 2, person: mara, excerpt: "Is the build green?", files: 0 } : null), id: sent.id };
    }
    return { ok: true };
  });
}
const page = (messages: TeamMessage[], older = false): TeamChatTimeline => ({ messages, older, newer: false, headSeq: messages.at(-1)?.seq ?? 0, read: null });
const pinnedBy = (at: number) => ({ by: mara, at: new Date(at).toISOString() });

it("counts the pins in the heading, lists the latest first and opens one in place", async () => {
  const older = { ...message(1, "Release checklist lives in the notes."), pinned: pinnedBy(1) };
  const newer = { ...message(2, "Ship on **Thursday**."), pinned: pinnedBy(2) };
  serve(
    ["base", "pins"],
    () => page([older, newer]),
    () => ({ pins: [newer, older].map((pinned) => ({ message: pinned, pinnedBy: mara, pinnedAt: pinned.pinned!.at })) }),
  );
  render(tree());
  fireEvent.click(await screen.findByRole("button", { name: "Pinned messages, 2" }));
  await screen.findAllByRole("listitem");
  expect([...document.querySelectorAll(".team-chat-pin-words")].map((words) => words.textContent)).toEqual(["Ship on Thursday.", "Release checklist lives in the notes."]);
  fireEvent.click(screen.getByText("Release checklist lives in the notes.", { selector: ".team-chat-pin-words" }));
  await waitFor(() => expect(document.querySelector('[data-message-id="m1"]')?.hasAttribute("data-found")).toBe(true));
  expect(screen.getAllByRole("img", { name: "Pinned by Mara Okafor" })).toHaveLength(2);
});

it("says when nothing is pinned, and offers to try again when the pins can't be read", async () => {
  let fail = true;
  serve(
    ["base", "pins"],
    () => page([message(2, "Is the build green?")]),
    async () => {
      if (fail) throw new Error("Couldn't load the pinned messages.");
      return { pins: [] };
    },
  );
  render(tree());
  fireEvent.click(await screen.findByRole("button", { name: "Pinned messages" }));
  expect(await screen.findByText("Couldn't load the pinned messages.")).toBeTruthy();
  fail = false;
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByText("No pinned messages")).toBeTruthy();
});

it("pins and unpins from the message's menu for everyone, and offers neither where the server has no pins", async () => {
  const call = serve(["base", "pins"], () => page([message(2, "Is the build green?")]));
  const view = render(tree());
  fireEvent.contextMenu(await screen.findByLabelText("Mara Okafor: Is the build green?"));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Pin" }));
  await waitFor(() => expect(call.mock.calls.find(([method]) => method === "teamChat.pin")?.[1]).toMatchObject({ messageId: "m2", pinned: true }));
  await screen.findByRole("img", { name: "Pinned by Alex Chen" });
  fireEvent.contextMenu(screen.getByLabelText("Mara Okafor: Is the build green?"));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Unpin" }));
  await waitFor(() => expect(call.mock.calls.filter(([method]) => method === "teamChat.pin").at(-1)?.[1]).toMatchObject({ pinned: false }));
  view.unmount();
  queryClient.clear();
  serve(["base"], () => page([message(2, "Is the build green?")]));
  render(tree());
  fireEvent.contextMenu(await screen.findByLabelText("Mara Okafor: Is the build green?"));
  await screen.findByRole("menuitem", { name: "Copy text" });
  expect(screen.queryByRole("menuitem", { name: "Pin" })).toBeNull();
  expect(screen.queryByRole("button", { name: /Pinned messages/ })).toBeNull();
});
