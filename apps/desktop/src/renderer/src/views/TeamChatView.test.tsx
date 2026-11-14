import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { TeamChatStatus, TeamChatTimeline, TeamConversation, TeamMessage } from "@openorc/protocol";
import { core } from "../lib/rpc";
import { queryClient } from "../lib/client";
import { TeamChatContext, type TeamChatContextValue } from "../lib/team-chat-context";
import { chatTimelineKey, teamChatDrafts } from "../lib/team-chat-queries";
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
const tree = (scope: TeamChatContextValue | null) => (
  <QueryClientProvider client={queryClient}>
    <TeamChatContext value={scope}>
      <TeamChatView target={target} />
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
  await screen.findByText("Loading messages…");
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
    call: null,
    createdAt: new Date(0).toISOString(),
  };
  await act(async () => finish({ ...page, messages: [secret], headSeq: 1 }));
  expect(screen.queryByText("Private history")).toBeNull();
  expect(queryClient.getQueryData(chatTimelineKey(scope, "general"))).toBeUndefined();
  expect(teamChatDrafts.read(target).text).toBe("Recover after access returns");
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
