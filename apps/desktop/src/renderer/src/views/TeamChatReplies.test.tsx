import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { RpcParams, TeamChatStatus, TeamChatTimeline, TeamConversation, TeamMessage } from "@openorc/protocol";
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

function serve(features: string[], pages: (params: RpcParams<"teamChat.timeline">) => TeamChatTimeline) {
  return vi.spyOn(core, "call").mockImplementation(async (method, params) => {
    if (method === "teamChat.state") return status(features);
    if (method === "teamChat.timeline") return pages(params as RpcParams<"teamChat.timeline">);
    if (method === "teamChat.send") {
      const sent = params as RpcParams<"teamChat.send">;
      return { ...message(3, sent.body, self, sent.replyToId ? { id: sent.replyToId, seq: 2, person: mara, excerpt: "Is the build green?", files: 0 } : null), id: sent.id };
    }
    return { ok: true };
  });
}
const page = (messages: TeamMessage[], older = false): TeamChatTimeline => ({ messages, older, newer: false, headSeq: messages.at(-1)?.seq ?? 0, read: null });

it("answers a message from the composer and sends the reply once, naming it", async () => {
  const call = serve(["base", "replies"], () => page([message(2, "Is the build green?")]));
  render(tree());
  fireEvent.click(await screen.findByRole("button", { name: "Reply" }));
  expect((await screen.findByText(/Replying to/)).textContent).toBe("Replying to Mara Okafor Is the build green?");
  teamChatDrafts.write(target, "Yes, all green");
  fireEvent.click(await screen.findByRole("button", { name: "Send" }));
  await waitFor(() => expect(call.mock.calls.filter(([method]) => method === "teamChat.send")).toHaveLength(1));
  expect(call.mock.calls.find(([method]) => method === "teamChat.send")?.[1]).toMatchObject({ body: "Yes, all green", replyToId: "m2" });
  await waitFor(() => expect(screen.queryByText(/Replying to/)).toBeNull());
  expect(screen.getByRole("button", { name: "Show the message from Mara Okafor: Is the build green?" })).toBeTruthy();
});

it("lets the close button answer no message", async () => {
  serve(["base", "replies"], () => page([message(2, "Is the build green?")]));
  render(tree());
  fireEvent.click(await screen.findByRole("button", { name: "Reply" }));
  fireEvent.click(await screen.findByRole("button", { name: "Cancel reply" }));
  expect(screen.queryByText(/Replying to/)).toBeNull();
  expect(teamChatDrafts.read(target).replyTo).toBeNull();
});

it("offers no Reply where the server has no replies", async () => {
  serve(["base"], () => page([message(2, "Is the build green?")]));
  render(tree());
  await screen.findByRole("button", { name: "React" });
  expect(screen.queryByRole("button", { name: "Reply" })).toBeNull();
});

it("opens an answered message that is not on the page by loading back to it, then marks it", async () => {
  const early = message(1, "The very first question");
  const later = Array.from({ length: 3 }, (_, index) => message(index + 70, `Later ${index}`));
  const reply = message(73, "Answering the first", self, { id: early.id, seq: 1, person: mara, excerpt: early.body, files: 0 });
  const call = serve(["base", "replies"], (params) => (params.beforeSeq ? page([early]) : page([...later, reply], true)));
  render(tree());
  fireEvent.click(await screen.findByRole("button", { name: "Show the message from Mara Okafor: The very first question" }));
  await waitFor(() => expect(document.querySelector('[data-message-id="m1"]')?.hasAttribute("data-found")).toBe(true));
  expect(call.mock.calls.filter(([method, params]) => method === "teamChat.timeline" && (params as { beforeSeq?: number }).beforeSeq === 70)).toHaveLength(1);
  expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
});
