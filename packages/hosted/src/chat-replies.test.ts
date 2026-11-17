import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHosted, type Hosted } from "./index.js";
import { hostDeps, newDevice, signInAs } from "./test-fixtures/host.js";
import { standIn, type StandIn } from "./testing/stand-in.js";
import { userOf } from "./testing/stand-in-spaces.js";

const FIRST = "first@example.com",
  SECOND = "second@example.com";
let stand: StandIn;
let spaceId: string;
const hosts: Hosted[] = [];
beforeEach(async () => {
  stand = await standIn({ signup: "open" });
  stand.chat.enabled = true;
  stand.chat.channelsEnabled = true;
  stand.chat.repliesEnabled = true;
  spaceId = stand.addTeam("Birch Studio", [FIRST, SECOND]);
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

it("sends a reply through the app's client and reads the message it answers, refusing one from another conversation", async () => {
  const first = await host(FIRST),
    second = await host(SECOND);
  const pair = await first.chat.openDm({ spaceId, userIds: [userOf(SECOND)] });
  const target = { spaceId, conversationId: pair.id };
  expect(await first.chat.state({ spaceId })).toMatchObject({ state: "ready", chat: { features: expect.arrayContaining(["replies"]) } });
  const question = await first.chat.send({ ...target, id: randomUUID(), body: "Ready for review?" });
  const answer = await second.chat.send({ ...target, id: randomUUID(), body: "Yes", replyToId: question.id });
  expect(answer.replyTo).toEqual({ id: question.id, seq: question.seq, person: question.actor.person, excerpt: "Ready for review?", files: 0 });
  expect((await first.chat.timeline(target)).messages.map((message) => message.replyTo?.id ?? null)).toEqual([null, question.id]);
  const other = await first.chat.createChannel({ spaceId, name: "elsewhere" });
  const elsewhere = await first.chat.send({ spaceId, conversationId: other.id, id: randomUUID(), body: "Elsewhere" });
  await expect(second.chat.send({ ...target, id: randomUUID(), body: "No", replyToId: elsewhere.id })).rejects.toThrow("That message isn't in this conversation.");
  expect((await first.chat.timeline(target)).messages).toHaveLength(2);
});
