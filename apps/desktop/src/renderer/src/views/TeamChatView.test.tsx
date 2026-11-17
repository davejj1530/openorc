import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { TeamChatStatus, TeamChatTimeline, TeamConversation, TeamMessage } from "@openorc/protocol";
import { core } from "../lib/rpc";
import { queryClient } from "../lib/client";
import { TeamChatContext, type TeamChatContextValue } from "../lib/team-chat-context";
import { chatStateKey, chatTimelineKey, teamChatDrafts } from "../lib/team-chat-queries";
import { channelDetailsKey } from "../lib/team-channel-queries";
import { TeamChatVisibility } from "../lib/team-chat-visibility";
import { TeamChatView } from "./TeamChatView";

vi.mock("../components/TopBar", () => ({ TopBar: ({ children }: { children: ReactNode }) => <header>{children}</header> }));
vi.mock("../components/ThreadTabs", () => ({ ThreadTabs: () => <span>Chat</span> }));
vi.mock("../components/ThreadImages", () => ({ ThreadRichText: ({ children }: { children: ReactNode }) => <span>{children}</span> }));
const target = { view: "team-chat" as const, accountId: "self", spaceId: "team", conversationId: "general" };
const person = { id: "self", name: "Alex Chen", image: null };
const conversation: TeamConversation = {
  id: "general",
  kind: "channel",
  name: "general",
  topic: null,
  private: false,
  members: [person],
  joined: true,
  lastMessageAt: null,
  canAddMembers: false,
  canRemoveMembers: false,
  createdAt: new Date(0).toISOString(),
  participants: null,
  lastMessageSeq: 0,
  read: null,
};
const state: TeamChatStatus = { state: "ready", accountId: "self", spaceId: "team", reach: "live", chat: { features: ["base"], people: [person], conversations: [conversation] } };
const page: TeamChatTimeline = { messages: [], older: false, newer: false, headSeq: 0, read: null };
function context(): TeamChatContextValue {
  return { ...target, generation: 1, reach: "live", current: () => true };
}
const tree = (scope: TeamChatContextValue | null, visible = true) => (
  <QueryClientProvider client={queryClient}>
    <TeamChatContext value={scope}>
      <TeamChatVisibility value={visible}>
        <TeamChatView target={target} />
      </TeamChatVisibility>
    </TeamChatContext>
  </QueryClientProvider>
);
afterEach(() => {
  cleanup();
  queryClient.clear();
  teamChatDrafts.forget(target);
  localStorage.clear();
  vi.restoreAllMocks();
});

it("keeps local words when an older server has no chat capability", async () => {
  vi.spyOn(core, "call").mockResolvedValue({ state: "unavailable" });
  teamChatDrafts.write(target, "Words from before the server changed");
  render(tree(context()));
  await waitFor(() => expect(screen.queryByText("Loading chat…")).toBeNull());
  expect(teamChatDrafts.read(target).text).toBe("Words from before the server changed");
});
it("closes channel details when the retained chat is no longer visible", async () => {
  vi.spyOn(core, "call").mockImplementation(async (method) => {
    if (method === "teamChat.state") return { ...state, chat: { ...state.chat, features: ["base", "channels"] } };
    if (method === "teamChat.conversation") return conversation;
    if (method === "teamChat.timeline") return page;
    return { ok: true };
  });
  const scope = context();
  const view = render(tree(scope));
  fireEvent.click(await screen.findByRole("button", { name: "Details for #general" }));
  await screen.findByRole("button", { name: "Done" });
  view.rerender(tree(scope, false));
  expect(screen.queryByRole("dialog")).toBeNull();
  view.rerender(tree(scope));
  expect(screen.queryByRole("dialog")).toBeNull();
});
it("cannot send into a channel after its subscription is removed before channel joining is available", async () => {
  vi.spyOn(core, "call").mockImplementation(async (method) => {
    if (method === "teamChat.state") return state;
    if (method === "teamChat.timeline") return page;
    return { ok: true };
  });
  const scope = context();
  teamChatDrafts.write(target, "Keep these words until I join again");
  render(tree(scope));
  await screen.findByRole("button", { name: "Send" });
  act(() => {
    queryClient.setQueryData(chatStateKey(scope), { ...state, chat: { ...state.chat, conversations: [{ ...conversation, joined: false }] } });
  });
  await waitFor(() => expect(screen.queryByRole("button", { name: "Send" })).toBeNull());
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  expect(teamChatDrafts.read(target).text).toBe("Keep these words until I join again");
});
it("shows public history with explicit joining after a subscription is removed", async () => {
  let joined = true;
  vi.spyOn(core, "call").mockImplementation(async (method) => {
    if (method === "teamChat.state") return { ...state, chat: { ...state.chat, features: ["base", "channels"], conversations: [{ ...conversation, joined }] } };
    if (method === "teamChat.timeline") return page;
    if (method === "teamChat.joinChannel") {
      joined = true;
      return conversation;
    }
    return { ok: true };
  });
  const scope = context();
  teamChatDrafts.write(target, "Keep these words until I join again");
  render(tree(scope));
  await screen.findByRole("button", { name: "Send" });
  joined = false;
  await act(async () => {
    await queryClient.invalidateQueries({ queryKey: chatStateKey(scope) });
  });
  const join = await screen.findByRole("button", { name: "Join channel" });
  expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
  expect(screen.getByText("No messages yet")).toBeTruthy();
  fireEvent.click(join);
  await screen.findByRole("button", { name: "Send" });
  expect(teamChatDrafts.read(target).text).toBe("Keep these words until I join again");
  expect(core.call).toHaveBeenCalledWith("teamChat.joinChannel", { spaceId: target.spaceId, conversationId: target.conversationId });
});
it("keeps a frozen draft while a late private page cannot enter the cache", async () => {
  let finish = (_page: TeamChatTimeline) => {};
  const delayed = new Promise<TeamChatTimeline>((resolve) => {
    finish = resolve;
  });
  vi.spyOn(core, "call").mockImplementation(async (method) => {
    if (method === "teamChat.state") return state;
    if (method === "teamChat.timeline") return delayed;
    return { ok: true };
  });
  let allowed = true;
  const scope = { ...context(), current: () => allowed };
  teamChatDrafts.write(target, "Recover after access returns");
  const view = render(tree(scope));
  await screen.findByText("Loading chat…");
  allowed = false;
  view.rerender(tree(null));
  const secret: TeamMessage = {
    id: "private",
    channelId: "general",
    seq: 1,
    actor: { kind: "person", person },
    body: "Private history",
    files: [],
    reactions: [],
    replyTo: null,
    pinned: null,
    call: null,
    createdAt: new Date(0).toISOString(),
  };
  await act(async () => finish({ ...page, messages: [secret], headSeq: 1 }));
  expect(screen.queryByText("Private history")).toBeNull();
  expect(queryClient.getQueryData(chatTimelineKey(scope, "general"))).toBeUndefined();
  expect(teamChatDrafts.read(target).text).toBe("Recover after access returns");
});
it("clears a removed private channel's draft and rejects its late details", async () => {
  let finish = (_value: TeamConversation) => {};
  const delayed = new Promise<TeamConversation>((resolve) => {
    finish = resolve;
  });
  const privateChannel = { ...conversation, private: true, topic: "Private planning details" };
  const ready: TeamChatStatus = { ...state, chat: { ...state.chat, features: ["base", "channels"], conversations: [privateChannel] } };
  vi.spyOn(core, "call").mockImplementation(async (method) => {
    if (method === "teamChat.state") return ready;
    if (method === "teamChat.timeline") return page;
    if (method === "teamChat.conversation") return delayed;
    return { ok: true };
  });
  const scope = context();
  teamChatDrafts.write(target, "Private unsent words");
  render(tree(scope));
  fireEvent.click(await screen.findByRole("button", { name: "Details for #general" }));
  await screen.findByText("Loading channel…");
  act(() => {
    queryClient.setQueryData(chatStateKey(scope), { ...ready, chat: { ...ready.chat, conversations: [] } });
  });
  await screen.findByText("You no longer have access to this chat.");
  await act(async () => {
    finish(privateChannel);
    await delayed;
  });
  expect(screen.queryByText("Private planning details")).toBeNull();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(queryClient.getQueryData(channelDetailsKey(scope, "general"))).toBeUndefined();
  expect(teamChatDrafts.read(target).text).toBe("");
});
it("shows one bubble when an unconfirmed send is found by a live refresh", async () => {
  let messages: TeamMessage[] = [];
  const call = vi.spyOn(core, "call").mockImplementation(async (method, params) => {
    if (method === "teamChat.state") return state;
    if (method === "teamChat.timeline") return { ...page, messages, headSeq: messages.length };
    if (method === "teamChat.send" && "body" in params && "id" in params) {
      messages = [
        {
          id: String(params.id),
          channelId: "general",
          seq: 1,
          actor: { kind: "person", person },
          body: String(params.body),
          files: [],
          reactions: [],
          replyTo: null,
          pinned: null,
          call: null,
          createdAt: new Date(0).toISOString(),
        },
      ];
      throw new Error("Delivery couldn't be confirmed.");
    }
    return { ok: true };
  });
  const scope = context();
  teamChatDrafts.write(target, "Ready for review");
  render(tree(scope));
  await screen.findByText("No messages yet");
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await screen.findByText("Message not sent");
  await act(async () => {
    await queryClient.invalidateQueries({ queryKey: chatTimelineKey(scope, "general") });
  });
  await waitFor(() => expect(screen.getAllByText("Ready for review")).toHaveLength(1));
  expect(teamChatDrafts.read(target).pending).toEqual([]);
  expect(call.mock.calls.filter(([method]) => method === "teamChat.send")).toHaveLength(1);
});

it("fills every missed page when reconnecting after more than sixty messages", async () => {
  const messages: TeamMessage[] = Array.from({ length: 126 }, (_, index) => ({
    id: `message-${index + 1}`,
    channelId: "general",
    seq: index + 1,
    actor: { kind: "person", person },
    body: `Message ${index + 1}`,
    files: [],
    reactions: [],
    replyTo: null,
    pinned: null,
    call: null,
    createdAt: new Date(0).toISOString(),
  }));
  let connected = false;
  vi.spyOn(core, "call").mockImplementation(async (method, params) => {
    if (method === "teamChat.state") return state;
    if (method !== "teamChat.timeline") return { ok: true };
    if (!connected) return { ...page, messages: messages.slice(0, 1), headSeq: 1 };
    const after = "afterSeq" in params ? Number(params.afterSeq) : undefined;
    const selected = after === undefined ? messages.slice(-60) : messages.slice(after, after + 60);
    return { ...page, messages: selected, headSeq: 126, older: selected[0]?.seq !== 1, newer: selected.at(-1)?.seq !== 126 };
  });
  const scope = context();
  render(tree(scope));
  await screen.findByText("Message 1");
  connected = true;
  await act(async () => {
    await queryClient.invalidateQueries({ queryKey: chatTimelineKey(scope, "general") });
  });
  expect(queryClient.getQueryData<TeamChatTimeline>(chatTimelineKey(scope, "general"))?.messages.map((message) => message.seq)).toEqual(messages.map((message) => message.seq));
});
