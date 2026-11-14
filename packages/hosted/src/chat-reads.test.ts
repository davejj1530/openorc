import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHosted, type Hosted } from "./index.js";
import { hostDeps, newDevice, signInAs } from "./test-fixtures/host.js";
import { standIn, type StandIn } from "./testing/stand-in.js";
import { userOf } from "./testing/stand-in-spaces.js";

const FIRST = "first@example.com",
  SECOND = "second@example.com",
  THIRD = "third@example.com";
let stand: StandIn;
let spaceId: string;
const hosts: Hosted[] = [];
beforeEach(async () => {
  stand = await standIn({ signup: "open" });
  stand.chat.enabled = true;
  stand.chat.unreadEnabled = true;
  spaceId = stand.addTeam("Birch Studio", [FIRST, SECOND, THIRD]);
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

it("keeps a bounded place through the app's client, names unread organizations and refuses an outsider's tag in a pair", async () => {
  const first = await host(FIRST),
    second = await host(SECOND);
  const pair = await first.chat.openDm({ spaceId, userIds: [userOf(SECOND)] });
  const target = { spaceId, conversationId: pair.id };
  const a = await first.chat.send({ ...target, id: randomUUID(), body: `@[user:${userOf(SECOND)}] first` });
  const b = await first.chat.send({ ...target, id: randomUUID(), body: "second" });
  expect((await second.chat.timeline(target)).read).toEqual({ seenSeq: 0, seenThroughMessageId: null, unread: 2, hasMention: true });
  expect(await second.chat.unreadSpaces({})).toEqual({ spaceIds: [spaceId] });
  expect(await second.chat.seen({ ...target, messageId: a.id })).toEqual({ seenSeq: a.seq, seenThroughMessageId: a.id, unread: 1, hasMention: false });
  expect((await second.chat.seen({ ...target, messageId: a.id })).seenSeq).toBe(a.seq);
  expect(await second.chat.seen({ ...target, messageId: b.id })).toMatchObject({ unread: 0 });
  expect(await second.chat.unreadSpaces({})).toEqual({ spaceIds: [] });
  await expect(first.chat.send({ ...target, id: randomUUID(), body: `@[user:${userOf(THIRD)}] not here` })).rejects.toThrow("Only people in this conversation can be mentioned here.");
  stand.chat.unreadEnabled = false;
  await first.chat.send({ ...target, id: randomUUID(), body: "while off" });
  expect(await second.chat.unreadSpaces({})).toEqual({ spaceIds: [] });
});
