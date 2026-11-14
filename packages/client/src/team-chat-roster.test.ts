import { expect, it } from "vitest";
import type { TeamConversation } from "@openorc/protocol";
import { teamChatRoster, teamChatShortNames, teamConversationTitle } from "./team-chat.js";

const people = [
  { id: "self", name: "Alex Chen", image: null },
  { id: "one", name: "Robin Patel", image: null },
  { id: "two", name: "Robin Lee", image: null },
];
const group: TeamConversation = {
  id: "group",
  kind: "dm",
  name: null,
  topic: null,
  private: true,
  joined: true,
  createdAt: new Date(0).toISOString(),
  lastMessageAt: null,
  lastMessageSeq: 4,
  read: null,
  canAddMembers: false,
  canRemoveMembers: false,
  members: people.slice(0, 2),
  participants: people.map((person, index) => ({ person, inOrganization: index !== 2 })),
};
it("keeps a departed fixed group separate from the remaining person's pair", () => {
  const pair = { ...group, id: "pair", participants: group.participants?.slice(0, 2) ?? [] };
  const rows = teamChatRoster({ features: ["base", "groups"], people: people.slice(0, 2), conversations: [group, pair] }, "self");
  expect(rows.map((row) => [row.kind, row.id, row.conversation?.id])).toEqual([
    ["person", "one", "pair"],
    ["conversation", "group", "group"],
  ]);
  expect(teamConversationTitle(group, "self")).toBe("Robin Patel, Robin Lee");
});
it("uses full pair names and keeps a group with identical names canonical by its id", () => {
  const same = { ...group, participants: group.participants?.map((participant) => ({ ...participant, person: { ...participant.person, name: "Robin Patel" } })) ?? [] };
  expect(teamConversationTitle(same, "self")).toBe("Robin Patel, Robin Patel");
  expect(teamConversationTitle({ ...group, participants: group.participants?.slice(0, 2) ?? [] }, "self")).toBe("Robin Patel");
  expect(teamChatRoster({ features: ["base"], people, conversations: [same] }, "self").map((row) => row.kind)).toEqual(["person", "person"]);
});
it("names people by first name unless two of them share it", () => {
  expect(teamChatShortNames(people)).toEqual(["Alex", "Robin Patel", "Robin Lee"]);
  expect(teamChatShortNames([people[0]!, people[1]!])).toEqual(["Alex", "Robin"]);
});
