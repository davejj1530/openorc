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
it("opens one fixed group for reordered participants and preserves a departed person's identity", async () => {
  const first = await host(FIRST),
    second = await host(SECOND);
  const group = await first.chat.openDm({ spaceId, userIds: [userOf(SECOND), userOf(THIRD)] });
  expect((await second.chat.openDm({ spaceId, userIds: [userOf(THIRD), userOf(FIRST)] })).id).toBe(group.id);
  const sent = await first.chat.send({ spaceId, conversationId: group.id, id: randomUUID(), body: "Keep the original group history." });
  const member = stand.spaces.member(spaceId, THIRD)!;
  stand.spaces.removeMember(spaceId, THIRD);
  const departed = await first.chat.conversation({ spaceId, conversationId: group.id });
  expect(departed.participants).toHaveLength(3);
  expect(departed.participants?.find(({ person }) => person.id === userOf(THIRD))?.inOrganization).toBe(false);
  expect(departed.members).toHaveLength(2);
  expect((await first.chat.openDm({ spaceId, userIds: [userOf(SECOND)] })).id).not.toBe(group.id);
  stand.spaces.teams.get(spaceId)!.members.push(member);
  const third = await host(THIRD);
  expect((await third.chat.conversation({ spaceId, conversationId: group.id })).participants?.every((person) => person.inOrganization)).toBe(true);
  expect((await third.chat.timeline({ spaceId, conversationId: group.id })).messages).toEqual([sent]);
});
