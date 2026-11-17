// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { createHosted, type Hosted } from "@openorc/hosted";
import { PlaceRouter } from "@openorc/hosted/router";
import { hostDeps, newDevice, signInAs } from "@openorc/hosted/test-fixtures";
import { standIn, type StandIn } from "@openorc/hosted/testing";
import type { RpcMethod, RpcParams, RpcResults, TeamConversation } from "@openorc/protocol";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createClientState } from "./client-state.js";
import type { ClientPush, CoreConnection } from "./connection.js";
import { answeredOf, teamChatCallLine } from "./team-chat-replies.js";
import { createTeamChat, teamChatList, type TeamChatLease } from "./team-chat-store.js";

/*
 * The chat stores as a phone holds them: over a session of OpenOrc Cloud of its own, through the phone's router, with
 * its Mac asleep. Its teammate writes from her own app; the phone hears of it by the chat's invalidations alone.
 */
const SELF = "theo@example.com",
  TEAMMATE = "mara@example.com";
const ASLEEP = "The phone is not connected to its Mac.";
let stand: StandIn;
let spaceId: string;
const hosts: Hosted[] = [];
let ids = 0;
const randomId = () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`;

beforeEach(async () => {
  stand = await standIn({ signup: "open" });
  Object.assign(stand.chat, { enabled: true, channelsEnabled: true, unreadEnabled: true, repliesEnabled: true, pinsEnabled: true, searchEnabled: true, orclingEnabled: true, presenceEnabled: true });
  stand.setPerson(SELF, { name: "Theo Laurent", image: null });
  stand.setPerson(TEAMMATE, { name: "Mara Okafor", image: null });
  spaceId = stand.addTeam("Birch Studio", [SELF, TEAMMATE]);
});
afterEach(async () => {
  cleanup();
  hosts.splice(0).forEach((host) => host.close());
  await stand.close();
});

async function host(email: string, push: (push: ClientPush) => void = () => undefined) {
  const { deps, browser } = hostDeps(stand, newDevice(), { push: (sent) => void (sent.type === "invalidate" && push(sent)) });
  const hosted = createHosted(deps);
  hosts.push(hosted);
  await hosted.start();
  await signInAs(hosted, browser, email);
  await vi.waitFor(() => expect(hosted.spaces.status().state).toBe("ready"));
  return hosted;
}

/** The phone: its own session answers through its router, and every call meant for the Mac finds it asleep. */
async function phone() {
  const listeners = new Set<(push: ClientPush) => void>();
  const hosted = await host(SELF, (push) => listeners.forEach((listener) => listener(push)));
  const toMac: string[] = [];
  const router = new PlaceRouter({
    place: () => hosted.threads,
    spaces: () => hosted.spaces,
    chat: () => hosted.chat,
    next: async (request) => {
      toMac.push(request.method);
      return { type: "rpc.error", id: request.id, message: ASLEEP };
    },
  });
  let id = 0;
  const connection: CoreConnection = {
    delivery: "interest",
    call: async <M extends RpcMethod>(method: M, params: RpcParams<M>) => {
      const reply = await router.handle({ type: "rpc", id: ++id, method, params });
      if (reply.type === "rpc.error") throw new Error(reply.message);
      return reply.result as RpcResults[M];
    },
    onPush: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setFrameInterest: () => undefined,
  };
  const client = createClientState(connection, {
    scheduleFrame: (callback) => void setTimeout(callback, 0),
    invalidationBatchMs: 0,
    randomId,
    savesDefaultPermission: false,
    reportFrameError: () => undefined,
  });
  const saved = new Map<string, string>();
  const storage = {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => void saved.set(key, value),
    removeItem: (key: string) => void saved.delete(key),
    key: (index: number) => [...saved.keys()][index] ?? null,
    get length() {
      return saved.size;
    },
  };
  const chat = createTeamChat({ connection, queryClient: client.queryClient, storage, randomId });
  const status = hosted.spaces.status();
  if (status.state !== "ready") throw new Error("Spaces aren't ready");
  const lease: TeamChatLease = { accountId: status.userId, spaceId, generation: 1, reach: "live", current: () => true };
  return { chat, connection, lease, toMac, self: status.userId };
}

it("lists the organization's conversations with what is unread, and clears it once the person has seen it", async () => {
  const mara = await host(TEAMMATE);
  const { chat, connection, lease, self, toMac } = await phone();
  const channel = await connection.call("teamChat.createChannel", { spaceId, name: "launch" });
  await mara.chat.joinChannel({ spaceId, conversationId: channel.id });
  const { result } = renderHook(() => teamChatList(chat.useChatState(lease).data, self));
  await waitFor(() => expect(result.current.map((row) => row.title)).toEqual(["Mara Okafor", "general", "launch"]));

  const said = await mara.chat.send({ spaceId, conversationId: channel.id, id: randomId(), body: "Is the checklist done?" });
  await waitFor(() => expect(result.current.find((row) => row.id === channel.id)).toMatchObject({ unread: 1, mentioned: false }));
  await act(() => chat.seen(lease, { accountId: lease.accountId, spaceId, conversationId: channel.id }, said));
  await waitFor(() => expect(result.current.find((row) => row.id === channel.id)?.unread).toBe(0));
  expect(toMac).toEqual([]);
});

it("shows a conversation's messages live, sends a reply from the draft, and pins it for everyone", async () => {
  const mara = await host(TEAMMATE);
  const { chat, connection, lease } = await phone();
  const channel: TeamConversation = await connection.call("teamChat.createChannel", { spaceId, name: "release" });
  await mara.chat.joinChannel({ spaceId, conversationId: channel.id });
  const target = { accountId: lease.accountId, spaceId, conversationId: channel.id };
  const { result } = renderHook(() => {
    chat.useWatch(lease, channel.id);
    return { timeline: chat.useTimeline(lease, channel.id).data, draft: chat.useDraft(target), pins: chat.usePins(lease, channel.id).data };
  });
  await waitFor(() => expect(result.current.timeline?.messages).toEqual([]));

  const question = await mara.chat.send({ spaceId, conversationId: channel.id, id: randomId(), body: "Can we ship tonight?" });
  await waitFor(() => expect(result.current.timeline?.messages.map((message) => message.body)).toEqual(["Can we ship tonight?"]));

  act(() => {
    chat.drafts.write(target, "After the smoke test");
    chat.drafts.reply(target, answeredOf(question));
  });
  expect(result.current.draft.replyTo).toMatchObject({ id: question.id, excerpt: "Can we ship tonight?" });
  const pending = chat.drafts.begin(target)!;
  await act(() => chat.send(lease, target, pending));
  expect(result.current.draft).toMatchObject({ text: "", replyTo: null, pending: [] });
  const answer = result.current.timeline!.messages.at(-1)!;
  expect(answer).toMatchObject({ body: "After the smoke test", replyTo: { id: question.id } });

  await act(() => chat.pin(lease, target, answer, true));
  await waitFor(() => expect(result.current.pins?.pins.map((pin) => pin.message.id)).toEqual([answer.id]));
});

it("keeps a send it couldn't deliver, with its reason, and the same message when tried again", async () => {
  const { chat, connection, lease, toMac } = await phone();
  const channel = await connection.call("teamChat.createChannel", { spaceId, name: "ask-rini" });
  const target = { accountId: lease.accountId, spaceId, conversationId: channel.id };
  const { result } = renderHook(() => chat.useDraft(target));
  act(() => {
    chat.drafts.write(target, "@Rini what's left?");
    chat.drafts.callOrcling(target, { localOrclingId: "rini", name: "Rini", look: { shape: 3, eyes: 1, texture: 0, glasses: 2, accessory: 1, bodyColor: "#52b8a0", eyeColor: "#1b1c20" } });
  });
  const pending = chat.drafts.begin(target)!;
  await act(() => chat.send(lease, target, pending));
  expect(result.current.pending).toEqual([expect.objectContaining({ id: pending.id, state: "failed", error: ASLEEP, orcling: expect.objectContaining({ callId: pending.orcling!.callId }) })]);
  await act(() => chat.send(lease, target, result.current.pending[0]!));
  expect(result.current.pending.map((message) => [message.id, message.state])).toEqual([[pending.id, "failed"]]);
  expect(toMac).toEqual(["teamChat.send", "teamChat.send"]);
});

it("finds messages, says who is connected, and words a teammate's Orcling call as it goes", async () => {
  const mara = await host(TEAMMATE);
  const { chat, connection, lease, self } = await phone();
  const channel = await connection.call("teamChat.createChannel", { spaceId, name: "notes" });
  await mara.chat.joinChannel({ spaceId, conversationId: channel.id });
  const look = { shape: 3, eyes: 1, texture: 0, glasses: 2, accessory: 1, bodyColor: "#52b8a0", eyeColor: "#1b1c20" };
  const callId = randomId();
  const asked = await mara.chat.send(
    { spaceId, conversationId: channel.id, id: randomId(), body: "@Pip summarize the notes" },
    { id: callId, localOrclingId: "pip", name: "Pip", look, runnerSecret: "a-secret-only-maras-app-holds-0000000000000" },
  );

  const { result } = renderHook(() => ({
    hits: chat.useSearch(lease, "summarize").data,
    presence: chat.usePresence(lease, true),
    timeline: chat.useTimeline(lease, channel.id).data,
    owner: chat.useOwnerCall(lease, asked.call, self),
  }));
  await waitFor(() => expect(result.current.hits?.hits.map((hit) => [hit.id, hit.channelId])).toEqual([[asked.id, channel.id]]));
  await waitFor(() => expect(result.current.presence.get(self)).toBe("connected"));
  await waitFor(() => expect(result.current.timeline?.messages).toHaveLength(1));
  expect(teamChatCallLine(result.current.timeline!.messages[0]!.call, self)).toEqual({ words: "Pip is answering…", failed: false, canRetry: false });
  expect(result.current.owner.fetchStatus).toBe("idle");
});
