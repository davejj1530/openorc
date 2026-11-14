import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHosted, type Hosted, type HostedDeps } from "./index.js";
import { hostDeps, newDevice, signInAs } from "./test-fixtures/host.js";
import { standIn, type StandIn } from "./testing/stand-in.js";
import { userOf } from "./testing/stand-in-spaces.js";

const ADMIN = "admin@example.com";
const MEMBER = "member@example.com";
const THIRD = "third@example.com";
let stand: StandIn;
let spaceId: string;
const hosts: Hosted[] = [];
beforeEach(async () => {
  stand = await standIn({ signup: "open" });
  stand.chat.enabled = true;
  spaceId = stand.addTeam("Example Studio", [ADMIN, MEMBER, THIRD]);
});
afterEach(async () => {
  hosts.splice(0).forEach((host) => host.close());
  await stand.close();
});
async function host(email: string, overrides: Partial<HostedDeps> = {}) {
  const { deps, browser } = hostDeps(stand, newDevice(), overrides);
  const hosted = createHosted(deps);
  hosts.push(hosted);
  await hosted.start();
  await signInAs(hosted, browser, email);
  await vi.waitFor(() => expect(hosted.spaces.status().state).toBe("ready"));
  return hosted;
}

it("reads public history before joining and preserves a deliberate leave on later reads", async () => {
  const first = await host(ADMIN);
  const second = await host(MEMBER);
  const channel = await first.chat.createChannel({ spaceId, name: "  Review-Room  ", topic: "Review the next release" });
  const target = { spaceId, conversationId: channel.id };
  expect(channel).toMatchObject({ name: "review-room", joined: true, canAddMembers: true, canRemoveMembers: true });
  await expect(first.chat.createChannel({ spaceId, name: "review-room" })).rejects.toMatchObject({ status: 409, message: "#review-room already exists." });
  const sent = await first.chat.send({ ...target, id: randomUUID(), body: "Earlier history remains readable." });
  expect(await second.chat.conversation(target)).toMatchObject({ joined: false, canAddMembers: false, canRemoveMembers: false });
  expect((await second.chat.timeline(target)).messages).toEqual([sent]);
  expect(await second.chat.joinChannel(target)).toMatchObject({ joined: true, canAddMembers: true, canRemoveMembers: false });
  expect((await second.chat.joinChannel(target)).members).toHaveLength(2);
  expect(await second.chat.leaveChannel(target)).toEqual({});
  expect(await second.chat.conversation(target)).toMatchObject({ joined: false });
  const state = await second.chat.state({ spaceId });
  expect(state.state === "ready" && state.chat.conversations.find((item) => item.id === channel.id)?.joined).toBe(false);
});

it("requires private membership even for an admin and applies current member capabilities", async () => {
  const creator = await host(MEMBER);
  const admin = await host(ADMIN);
  const channel = await creator.chat.createChannel({ spaceId, name: "planning", private: true });
  const target = { spaceId, conversationId: channel.id };
  await expect(admin.chat.conversation(target)).rejects.toMatchObject({ status: 404 });
  await expect(admin.chat.joinChannel(target)).rejects.toMatchObject({ status: 404 });
  await creator.chat.addMembers({ ...target, userIds: [userOf(ADMIN)] });
  expect(await admin.chat.conversation(target)).toMatchObject({ canAddMembers: true, canRemoveMembers: true });
  await admin.chat.removeMember({ ...target, userId: userOf(MEMBER) });
  await expect(creator.chat.conversation(target)).rejects.toMatchObject({ status: 404 });
  await expect(creator.chat.addMembers({ ...target, userIds: [userOf(THIRD)] })).rejects.toMatchObject({ status: 404 });
  await expect(admin.chat.addMembers({ ...target, userIds: ["foreign-person"] })).rejects.toMatchObject({ status: 400 });
  expect((await admin.chat.conversation(target)).members.map((person) => person.id)).toEqual([userOf(ADMIN)]);
});

it("does not repeat a channel creation after the server committed but its response was lost", async () => {
  let lose = true;
  const hosted = await host(ADMIN, {
    fetch: async (input, init) => {
      const response = await fetch(input, init);
      if (lose && init?.method === "POST" && new URL(String(input)).pathname === "/chat/channels") {
        lose = false;
        throw new Error("Lost reply");
      }
      return response;
    },
  });
  await expect(hosted.chat.createChannel({ spaceId, name: "review-room" })).rejects.toThrow("can't be reached");
  const state = await hosted.chat.state({ spaceId });
  expect(state.state === "ready" && state.chat.conversations.filter((channel) => channel.name === "review-room")).toHaveLength(1);
  expect(stand.requests.filter((request) => request.path === "/chat/channels")).toHaveLength(1);
});

it("discards details fetched before a private member was removed", async () => {
  const creator = await host(ADMIN);
  const channel = await creator.chat.createChannel({ spaceId, name: "planning", private: true, userIds: [userOf(MEMBER)] });
  const target = { spaceId, conversationId: channel.id };
  let release = () => {};
  let delayed = false;
  const member = await host(MEMBER, {
    fetch: async (input, init) => {
      const response = await fetch(input, init);
      if (!delayed && new URL(String(input)).pathname.endsWith(`/conversations/${channel.id}`)) {
        delayed = true;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return response;
    },
  });
  const read = member.chat.conversation(target);
  const rejected = expect(read).rejects.toMatchObject({ status: 404 });
  await vi.waitFor(() => expect(delayed).toBe(true));
  await creator.chat.removeMember({ ...target, userId: userOf(MEMBER) });
  release();
  await rejected;
});
