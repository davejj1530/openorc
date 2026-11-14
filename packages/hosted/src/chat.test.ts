import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHosted, type Hosted, type HostedDeps } from "./index.js";
import { hostDeps, newDevice, signInAs } from "./test-fixtures/host.js";
import { standIn, type StandIn } from "./testing/stand-in.js";
import { userOf } from "./testing/stand-in-spaces.js";

const FIRST = "first@example.com";
const SECOND = "second@example.com";
let stand: StandIn;
let spaceId: string;
const hosts: Hosted[] = [];
beforeEach(async () => {
  stand = await standIn({ signup: "open" });
  stand.chat.enabled = true;
  spaceId = stand.addTeam("Birch Studio", [FIRST, SECOND]);
});
afterEach(async () => {
  hosts.splice(0).forEach((host) => host.close());
  await stand.close();
});
async function host(email = FIRST, overrides: Partial<HostedDeps> = {}) {
  const { deps, browser, seen } = hostDeps(stand, newDevice(), overrides);
  const hosted = createHosted(deps);
  hosts.push(hosted);
  await hosted.start();
  await signInAs(hosted, browser, email);
  await vi.waitFor(() => expect(hosted.spaces.status().state).toBe("ready"));
  return { hosted, seen };
}

it("loads the explicit organization's roster/general without agent sign-in or hours", async () => {
  const { hosted } = await host();
  const state = await hosted.chat.state({ spaceId });
  expect(state).toMatchObject({
    state: "ready",
    accountId: userOf(FIRST),
    spaceId,
    chat: { features: ["base"], people: [{ id: userOf(FIRST) }, { id: userOf(SECOND) }], conversations: [{ name: "general", read: null }] },
  });
  expect(await hosted.chat.state({ spaceId: `personal-${FIRST}` })).toEqual({ state: "unavailable" });
});

it("distinguishes an unsupported server from an unreachable server", async () => {
  const { hosted } = await host();
  stand.chat.enabled = false;
  expect(await hosted.chat.state({ spaceId })).toEqual({ state: "unavailable" });
  await stand.down();
  await expect(hosted.chat.state({ spaceId })).rejects.toThrow("can't be reached");
});

it("opens one canonical direct message from racing actions", async () => {
  const { hosted } = await host();
  const input = { spaceId, userIds: [userOf(SECOND)] };
  const [first, second] = await Promise.all([hosted.chat.openDm(input), hosted.chat.openDm(input)]);
  expect(second.id).toBe(first.id);
  expect(stand.requests.filter((request) => request.path === "/chat/dms")).toHaveLength(1);
  expect((await hosted.chat.openDm(input)).id).toBe(first.id);
});

it("repairs lost send responses through live delivery and a stable message UUID", async () => {
  let lose = true;
  const first = await host(FIRST, {
    fetch: async (input, init) => {
      const response = await fetch(input, init);
      if (lose && init?.method === "POST" && new URL(String(input)).pathname.endsWith("/messages")) {
        lose = false;
        throw new Error("Lost reply");
      }
      return response;
    },
  });
  const second = await host(SECOND);
  const conversation = await first.hosted.chat.openDm({ spaceId, userIds: [userOf(SECOND)] });
  const conversationId = conversation.id;
  expect(await second.hosted.chat.watch({ spaceId, conversationId, requestId: randomUUID() })).toEqual({ ok: true });
  second.seen.pushes.length = 0;
  const input = { spaceId, conversationId, id: randomUUID(), body: "Here is the first message." };
  await expect(first.hosted.chat.send(input)).rejects.toThrow("can't be reached");
  await vi.waitFor(() => expect(second.seen.pushes).toContainEqual({ type: "invalidate", keys: [`team-chat:${spaceId}`, `team-chat:${spaceId}:${conversationId}`, "team-chat-unread"] }));
  const retried = await first.hosted.chat.send(input);
  expect((await second.hosted.chat.timeline({ spaceId, conversationId })).messages).toEqual([retried]);
  await expect(first.hosted.chat.send({ ...input, body: "Changed text" })).rejects.toMatchObject({ status: 409, code: "message_id_conflict" });
});

it("keeps the six reaction choices on the stored message", async () => {
  const { hosted } = await host();
  const conversation = await hosted.chat.openDm({ spaceId, userIds: [userOf(SECOND)] });
  const input = { spaceId, conversationId: conversation.id };
  const message = await hosted.chat.send({ ...input, id: randomUUID(), body: "Ready for review." });
  for (const emoji of ["👍", "❤️", "😄", "🎉", "👀", "✅"] as const) await hosted.chat.react({ ...input, messageId: message.id, emoji });
  expect((await hosted.chat.timeline(input)).messages[0]?.reactions).toHaveLength(6);
});

it("drops a page admitted before access froze", async () => {
  let release: (() => void) | undefined;
  let started: (() => void) | undefined;
  const waiting = new Promise<void>((resolve) => {
    started = resolve;
  });
  const { hosted } = await host(FIRST, {
    fetch: async (input, init) => {
      const response = await fetch(input, init);
      if (new URL(String(input)).pathname.endsWith("/timeline")) {
        started?.();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return response;
    },
  });
  const conversation = await hosted.chat.openDm({ spaceId, userIds: [userOf(SECOND)] });
  const read = hosted.chat.timeline({ spaceId, conversationId: conversation.id });
  const rejected = expect(read).rejects.toThrow("session changed");
  await waiting;
  stand.chat.frozen.add(FIRST);
  stand.chat.changeAccess(spaceId);
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  release?.();
  await rejected;
  await expect(hosted.chat.state({ spaceId })).rejects.toMatchObject({ code: "organization_frozen" });
});

it("does not reveal a private chat to an organization outsider", async () => {
  const privateChat = stand.chat.seed(spaceId, { name: "planning", private: true, userIds: [userOf(FIRST)] });
  const { hosted } = await host(SECOND);
  const state = await hosted.chat.state({ spaceId });
  expect(state.state === "ready" && state.chat.conversations.some((conversation) => conversation.id === privateChat.id)).toBe(false);
  await expect(hosted.chat.timeline({ spaceId, conversationId: privateChat.id })).rejects.toMatchObject({ status: 404 });
});

it("discards a delayed private page after a conversation-only removal", async () => {
  let release = () => {};
  let delay = true;
  const privateChat = stand.chat.seed(spaceId, { name: "planning", private: true, userIds: [userOf(FIRST)] });
  const { hosted } = await host(FIRST, {
    fetch: async (input, init) => {
      const response = await fetch(input, init);
      if (delay && new URL(String(input)).pathname.endsWith("/timeline")) {
        delay = false;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return response;
    },
  });
  const read = hosted.chat.timeline({ spaceId, conversationId: privateChat.id });
  const rejected = expect(read).rejects.toMatchObject({ status: 404 });
  await vi.waitFor(() => expect(stand.requests.some((request) => request.path.endsWith("/timeline"))).toBe(true));
  privateChat.members = [];
  stand.chat.changeAccess(spaceId, ["chat"]);
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  release();
  await rejected;
});

it("rereads a page when live delivery overtakes the response", async () => {
  let release = () => {};
  let delayed = false;
  const first = await host(FIRST, {
    fetch: async (input, init) => {
      const response = await fetch(input, init);
      if (!delayed && new URL(String(input)).pathname.endsWith("/timeline")) {
        delayed = true;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return response;
    },
  });
  const second = await host(SECOND);
  const conversation = await first.hosted.chat.openDm({ spaceId, userIds: [userOf(SECOND)] });
  const target = { spaceId, conversationId: conversation.id };
  const read = first.hosted.chat.timeline(target);
  await vi.waitFor(() => expect(delayed).toBe(true));
  const sent = await second.hosted.chat.send({ ...target, id: randomUUID(), body: "Arrived while the page was on its way." });
  release();
  expect((await read).messages).toEqual([sent]);
});
