import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { RemoteTestClient } from "./test-client.js";
import { CLOUD, cloudMac, TODAY, type CloudMac } from "./test-fixtures/cloud-mac.js";

/*
 * A phone that shares cloud threads, with no session of OpenOrc Cloud of its own, uses its organization's team chat
 * through the Mac, as the person signed in there. The server decides every call; the phone hears which chats changed.
 */
const FROM_PHONE = "This is not available from a phone.";
let at: CloudMac;
let phone: RemoteTestClient;
beforeAll(async () => {
  at = await cloudMac();
  Object.assign(at.stand.chat, {
    enabled: true,
    channelsEnabled: true,
    unreadEnabled: true,
    repliesEnabled: true,
    pinsEnabled: true,
    searchEnabled: true,
    orclingEnabled: true,
    presenceEnabled: true,
  });
  phone = await at.phone(CLOUD);
}, 30_000);
afterAll(() => at.close());

it("reads, writes, pins and searches an organization's chat through the Mac", async () => {
  const spaceId = at.cloud.birch;
  expect(await phone.request("teamChat.state", { spaceId })).toMatchObject({ state: "ready", spaceId, chat: { features: expect.arrayContaining(["replies", "pins", "search", "presence"]) } });
  const channel = (await phone.request("teamChat.createChannel", { spaceId, name: "launch" })) as { id: string };
  const target = { spaceId, conversationId: channel.id };
  const said = (await phone.request("teamChat.send", { ...target, id: randomUUID(), body: "The launch checklist is done" })) as { id: string; seq: number };
  const reply = (await phone.request("teamChat.send", { ...target, id: randomUUID(), body: "Except the smoke test", replyToId: said.id })) as { replyTo: { id: string } };
  expect(reply.replyTo.id).toBe(said.id);
  expect(await phone.request("teamChat.pin", { ...target, messageId: said.id, pinned: true })).toMatchObject({ pinned: { at: expect.any(String) } });
  expect(await phone.request("teamChat.pins", target)).toMatchObject({ pins: [{ message: { id: said.id } }] });
  expect(await phone.request("teamChat.search", { spaceId, q: "checklist" })).toMatchObject({ hits: [{ id: said.id, channelId: channel.id }] });
  expect(await phone.request("teamChat.timeline", target)).toMatchObject({ messages: [{ id: said.id }, { replyTo: { id: said.id } }] });
});

it("hears that someone's apps came or went, and which chats changed, and nothing of what they say", async () => {
  const spaceId = at.cloud.birch;
  const before = phone.pushes.length;
  at.stand.chat.presenceChanged(spaceId);
  await vi.waitFor(() => expect(phone.pushes.slice(before)).toContainEqual({ type: "invalidate", keys: [`team-chat-presence:${spaceId}`] }), { timeout: 5_000 });
  const channel = (await at.window("teamChat.createChannel", { spaceId, name: "quiet" })) as { id: string };
  await at.window("teamChat.send", { spaceId, conversationId: channel.id, id: randomUUID(), body: "Words stay on the server" });
  await vi.waitFor(() => expect(phone.pushes.slice(before).some((push) => push.type === "invalidate" && push.keys.includes(`team-chat:${spaceId}:${channel.id}`))).toBe(true), { timeout: 5_000 });
  expect(JSON.stringify(phone.pushes.slice(before))).not.toContain("Words stay on the server");
});

it("refuses a message calling an Orcling this Mac doesn't have, and sends nothing", async () => {
  const spaceId = at.cloud.birch;
  const channel = (await phone.request("teamChat.createChannel", { spaceId, name: "ask" })) as { id: string };
  const target = { spaceId, conversationId: channel.id };
  await expect(phone.request("teamChat.send", { ...target, id: randomUUID(), body: "@Ghost hi", orcling: { callId: randomUUID(), localOrclingId: "no-such-orcling" } })).rejects.toThrow();
  expect(await phone.request("teamChat.timeline", target)).toMatchObject({ messages: [] });
});

it("refuses team chat to a phone that doesn't share cloud threads", async () => {
  const older = await at.phone(TODAY);
  await expect(older.request("teamChat.state", { spaceId: at.cloud.birch })).rejects.toThrow(FROM_PHONE);
  await expect(older.request("teamChat.unreadSpaces", {})).rejects.toThrow(FROM_PHONE);
});
