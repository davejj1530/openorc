import { expect, it } from "vitest";
import type { TeamConversation } from "@openorc/protocol";
import { TeamChatClosedGroups } from "./team-chat-closed-groups";

const scope = { accountId: "self", spaceId: "team" };
const group: Pick<TeamConversation, "id" | "kind" | "participants" | "lastMessageSeq"> = {
  id: "group",
  kind: "dm",
  lastMessageSeq: 4,
  participants: ["self", "one", "two"].map((id) => ({ person: { id, name: id, image: null }, inOrganization: true })),
};
function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  };
}
it("keeps a group closed through relaunch only on the same account, space and device", () => {
  const disk = storage();
  expect(new TeamChatClosedGroups(disk).close(scope, group)).toBe(true);
  const restored = new TeamChatClosedGroups(disk);
  expect(restored.isClosed(scope, group)).toBe(true);
  expect(restored.isClosed({ ...scope, accountId: "another" }, group)).toBe(false);
  expect(restored.isClosed({ ...scope, spaceId: "another" }, group)).toBe(false);
  expect(new TeamChatClosedGroups(storage()).isClosed(scope, group)).toBe(false);
});
it("reopens on newer activity and cannot be hidden again by an older cached head", () => {
  const disk = storage();
  const closed = new TeamChatClosedGroups(disk);
  closed.close(scope, group);
  closed.reconcile(scope, [group]);
  expect(closed.isClosed(scope, group)).toBe(true);
  const arrived = { ...group, lastMessageSeq: 5 };
  expect(closed.isClosed(scope, arrived)).toBe(false);
  closed.reconcile(scope, [arrived]);
  expect(closed.isClosed(scope, group)).toBe(false);
  expect(new TeamChatClosedGroups(disk).isClosed(scope, group)).toBe(false);
});
it("an explicit reopen removes the marker without changing group membership", () => {
  const closed = new TeamChatClosedGroups(storage());
  closed.close(scope, group);
  closed.reopen(scope, group.id);
  expect(closed.isClosed(scope, group)).toBe(false);
  expect(group.participants).toHaveLength(3);
});
it("never closes a person's pair or a channel and keeps a departed fixed group distinct", () => {
  const closed = new TeamChatClosedGroups(storage());
  expect(closed.close(scope, { ...group, participants: group.participants?.slice(0, 2) ?? [] })).toBe(false);
  expect(closed.close(scope, { ...group, kind: "channel", participants: null })).toBe(false);
  const departed = { ...group, participants: group.participants?.map((p, i) => ({ ...p, inOrganization: i < 2 })) ?? [] };
  expect(closed.close(scope, departed)).toBe(true);
  expect(closed.isClosed(scope, departed)).toBe(true);
});
it("forgets removed organization markers without touching another account or space", () => {
  const closed = new TeamChatClosedGroups(storage());
  const other = { ...scope, spaceId: "other" };
  const account = { ...scope, accountId: "other" };
  for (const at of [scope, other, account]) closed.close(at, group);
  closed.forgetSpace(scope.accountId, scope.spaceId);
  expect(closed.isClosed(scope, group)).toBe(false);
  expect(closed.isClosed(other, group)).toBe(true);
  expect(closed.isClosed(account, group)).toBe(true);
});
