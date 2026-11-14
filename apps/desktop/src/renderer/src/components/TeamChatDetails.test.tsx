import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { TeamConversation } from "@openorc/protocol";
import { core } from "../lib/rpc";
import { queryClient } from "../lib/client";
import { teamChatClosedGroups } from "../lib/team-chat-group-preferences";
import { TeamChatDetails } from "./TeamChatDetails";

const scope = { accountId: "self", spaceId: "team", generation: 1, reach: "live" as const, current: () => true };
const people = [
  { id: "self", name: "Alex Chen", image: null },
  { id: "one", name: "Robin Patel", image: null },
  { id: "two", name: "Casey Morgan", image: null },
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
afterEach(() => {
  cleanup();
  queryClient.clear();
  teamChatClosedGroups.forgetSpace("self", "team");
  vi.restoreAllMocks();
});
function tree(conversation: TeamConversation) {
  return (
    <QueryClientProvider client={queryClient}>
      <TeamChatDetails scope={scope} conversation={conversation} onClose={() => {}} />
    </QueryClientProvider>
  );
}
it("retains the original departed person and closes the group locally without a membership request", async () => {
  vi.spyOn(core, "call").mockResolvedValue(group);
  render(tree(group));
  expect(await screen.findByText("Casey Morgan")).toBeTruthy();
  expect(screen.getByText("No longer in the organization")).toBeTruthy();
  expect(screen.getByText("3 people")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Leave channel" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Close chat" }));
  expect(teamChatClosedGroups.isClosed(scope, group)).toBe(true);
  expect(core.call).toHaveBeenCalledTimes(1);
  expect(core.call).toHaveBeenCalledWith("teamChat.conversation", { spaceId: "team", conversationId: "group" });
});
it("shows pair details with Done and no local Close chat control", async () => {
  const pair = { ...group, id: "pair", participants: group.participants?.slice(0, 2) ?? [] };
  vi.spyOn(core, "call").mockResolvedValue(pair);
  render(tree(pair));
  expect(await screen.findByText("2 people")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Done" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Close chat" })).toBeNull();
});
