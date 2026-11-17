import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { RpcParams, TeamChatStatus, TeamChatTimeline, TeamConversation, TeamMessage, TeamOrclingCall } from "@openorc/protocol";
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

function serve(features: string[], pages: (params: RpcParams<"teamChat.timeline">) => TeamChatTimeline, reason: string | null = null) {
  return vi.spyOn(core, "call").mockImplementation(async (method, params) => {
    if (method === "teamChat.state") return status(features);
    if (method === "teamChat.timeline") return pages(params as RpcParams<"teamChat.timeline">);
    if (method === "orclings.list") return [];
    if (method === "teamChat.orclingCall") return { call: failed, reason, canRetry: true };
    if (method === "teamChat.send") {
      const sent = params as RpcParams<"teamChat.send">;
      return { ...message(3, sent.body, self, sent.replyToId ? { id: sent.replyToId, seq: 2, person: mara, orcling: null, excerpt: "Is the build green?", files: 0 } : null), id: sent.id };
    }
    return { ok: true };
  });
}
const page = (messages: TeamMessage[]): TeamChatTimeline => ({ messages, older: false, newer: false, headSeq: messages.at(-1)?.seq ?? 0, read: null });
const look = { shape: 3, eyes: 1, texture: 0, glasses: 2, accessory: 1, bodyColor: "#52b8a0", eyeColor: "#1b1c20" };
const call = (owner: typeof self, state: TeamOrclingCall["state"]): TeamOrclingCall => ({ id: "call-1", owner, localOrclingId: "rini", name: "Rini", look, state });
const failed = call(self, "failed");
const answer = (owner: typeof self): TeamMessage => ({
  ...message(3, "Ship it after the smoke test."),
  actor: { kind: "orcling", owner, localOrclingId: "rini", name: "Rini", look, callId: "call-1" },
});

it("shows an Orcling's answer as the Orcling, named as its owner's, apart from the owner's own messages", async () => {
  serve(["base", "orcling"], () => page([{ ...message(2, "@Rini should we ship?", mara), call: call(mara, "answered") }, answer(mara)]));
  render(tree());
  expect(await screen.findByText("Rini · Mara Okafor's Orcling")).toBeTruthy();
  expect(screen.getByLabelText("Rini: Ship it after the smoke test.")).toBeTruthy();
  expect(screen.queryByText(/is answering|couldn't answer/)).toBeNull();
});

it("says while the Orcling is answering, and names the person's own Orcling as theirs", async () => {
  serve(["base", "orcling"], () => page([{ ...message(2, "@Rini summarize", self), call: call(self, "running") }]));
  render(tree());
  expect(await screen.findByText("Rini is answering…")).toBeTruthy();
  cleanup();
  queryClient.clear();
  serve(["base", "orcling"], () => page([{ ...message(2, "@Rini summarize", self), call: call(self, "answered") }, answer(self)]));
  render(tree());
  expect(await screen.findByText("Rini · Your Orcling")).toBeTruthy();
});

it("lets only the owner try a call again, with the reason on demand; a teammate only reads that it couldn't answer", async () => {
  const calls = serve(["base", "orcling"], () => page([{ ...message(2, "@Rini summarize", self), call: failed }]), "Claude is signed out.");
  render(tree());
  fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
  await waitFor(() => expect(calls.mock.calls.find(([method]) => method === "teamChat.retryOrclingCall")?.[1]).toEqual({ spaceId: "team", conversationId: "general", callId: "call-1" }));
  await waitFor(() => expect(calls.mock.calls.some(([method]) => method === "teamChat.orclingCall")).toBe(true));
  cleanup();
  queryClient.clear();
  serve(["base", "orcling"], () => page([{ ...message(2, "@Rini summarize", mara), call: call(mara, "uncertain") }]));
  render(tree());
  expect(await screen.findByText("Rini couldn't answer")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
});

it("calls the picked Orcling only while its name stays in the words, once, with a call id kept for retries", () => {
  const rini = { localOrclingId: "rini", name: "Rini", look };
  teamChatDrafts.callOrcling(target, rini);
  teamChatDrafts.write(target, "@Rini what do you think?");
  const sent = teamChatDrafts.begin(target);
  expect(sent?.orcling).toMatchObject({ ...rini, callId: expect.any(String) });
  expect(teamChatDrafts.read(target).orcling).toBeNull();
  teamChatDrafts.callOrcling(target, rini);
  teamChatDrafts.write(target, "never mind");
  expect(teamChatDrafts.begin(target)?.orcling).toBeNull();
});
