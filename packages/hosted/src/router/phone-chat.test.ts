import { randomUUID } from "node:crypto";
import type { RpcMethod, RpcParams, RpcReply, RpcRequest, RpcResults } from "@openorc/protocol";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHosted, type Hosted } from "../index.js";
import { hostDeps, newDevice, signInAs } from "../test-fixtures/host.js";
import { standIn, type StandIn } from "../testing/stand-in.js";
import { userOf } from "../testing/stand-in-spaces.js";
import { PlaceRouter } from "./place-router.js";

/*
 * Team chat as a phone reads it from a session of OpenOrc Cloud of its own: the router answers every chat call from
 * that session, with the Mac asleep, and sends only a call that runs an Orcling down the link to the Mac.
 */
const SELF = "phone@example.com",
  TEAMMATE = "mara@example.com";
const ASLEEP = "Your Mac isn't reachable.";
let stand: StandIn;
let spaceId: string;
const hosts: Hosted[] = [];
beforeEach(async () => {
  stand = await standIn({ signup: "open" });
  Object.assign(stand.chat, { enabled: true, channelsEnabled: true, unreadEnabled: true, repliesEnabled: true, pinsEnabled: true, searchEnabled: true, orclingEnabled: true, presenceEnabled: true });
  spaceId = stand.addTeam("Birch Studio", [SELF, TEAMMATE]);
});
afterEach(async () => {
  hosts.splice(0).forEach((host) => host.close());
  await stand.close();
});

async function host(email: string) {
  const { deps, browser } = hostDeps(stand, newDevice());
  const hosted = createHosted(deps);
  hosts.push(hosted);
  await hosted.start();
  await signInAs(hosted, browser, email);
  await vi.waitFor(() => expect(hosted.spaces.status().state).toBe("ready"));
  return hosted;
}

/** The phone's router over its own session, with a link to a Mac that is asleep and records what it was asked. */
function phone(hosted: Hosted) {
  const asked: RpcRequest[] = [];
  const next = (request: RpcRequest): Promise<RpcReply> => {
    asked.push(request);
    return Promise.resolve({ type: "rpc.error", id: request.id, message: ASLEEP });
  };
  const router = new PlaceRouter({ place: () => hosted.threads, spaces: () => hosted.spaces, chat: () => hosted.chat, next });
  let id = 0;
  const call = async <M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<RpcResults[M]> => {
    const reply = await router.handle({ type: "rpc", id: ++id, method, params });
    if (reply.type === "rpc.error") throw new Error(reply.message);
    return reply.result as RpcResults[M];
  };
  return { asked, call };
}

it("reads, writes, pins, searches and marks read from the phone's own session while the Mac sleeps", async () => {
  const teammate = await host(TEAMMATE);
  const { asked, call } = phone(await host(SELF));
  expect(await call("teamChat.state", { spaceId })).toMatchObject({ state: "ready", chat: { features: expect.arrayContaining(["replies", "pins", "search", "orcling", "presence"]) } });
  const channel = await call("teamChat.createChannel", { spaceId, name: "launch" });
  const target = { spaceId, conversationId: channel.id };
  await teammate.chat.joinChannel(target);
  const question = await teammate.chat.send({ ...target, id: randomUUID(), body: "Is the launch checklist done?" });
  expect(await call("teamChat.watch", { ...target, requestId: randomUUID() })).toEqual({ ok: true });

  const answer = await call("teamChat.send", { ...target, id: randomUUID(), body: "Done except the smoke test", replyToId: question.id });
  expect(answer.replyTo).toMatchObject({ id: question.id, excerpt: "Is the launch checklist done?" });
  expect((await call("teamChat.pin", { ...target, messageId: question.id, pinned: true })).pinned).toMatchObject({ by: { id: userOf(SELF) } });
  expect((await call("teamChat.pins", target)).pins.map((pin) => pin.message.id)).toEqual([question.id]);
  expect((await call("teamChat.search", { spaceId, q: "checklist" })).hits.map((hit) => [hit.id, hit.channelId])).toEqual(expect.arrayContaining([[question.id, channel.id]]));
  expect((await call("teamChat.timeline", target)).messages.map((message) => message.body)).toEqual(["Is the launch checklist done?", "Done except the smoke test"]);
  expect(await call("teamChat.seen", { ...target, messageId: answer.id })).toMatchObject({ seenSeq: answer.seq });
  const presence = await call("teamChat.presence", { spaceId });
  expect(presence.people.find((person) => person.id === userOf(SELF))).toEqual({ id: userOf(SELF), state: "connected" });

  expect(asked).toEqual([]);
});

it("sends a message that calls an Orcling, and a retry of its call, to the Mac that holds the Orcling, and nothing to the server while it sleeps", async () => {
  const { asked, call } = phone(await host(SELF));
  const channel = await call("teamChat.createChannel", { spaceId, name: "ask-rini" });
  const target = { spaceId, conversationId: channel.id };
  const callId = randomUUID();
  await expect(call("teamChat.send", { ...target, id: randomUUID(), body: "@Rini what's left?", orcling: { callId, localOrclingId: "rini" } })).rejects.toThrow(ASLEEP);
  await expect(call("teamChat.retryOrclingCall", { ...target, callId })).rejects.toThrow(ASLEEP);
  expect(asked.map((request) => request.method)).toEqual(["teamChat.send", "teamChat.retryOrclingCall"]);
  expect((await call("teamChat.timeline", target)).messages).toEqual([]);
});
