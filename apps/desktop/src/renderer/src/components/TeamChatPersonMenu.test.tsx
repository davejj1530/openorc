import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { OrganizationPerson, TeamChatStatus, TeamConversation } from "@openorc/protocol";
import { core } from "../lib/rpc";
import { queryClient } from "../lib/client";
import { useRouter } from "../lib/router";
import { TeamChatContext } from "../lib/team-chat-context";
import { chatStateKey } from "../lib/team-chat-queries";
import { TeamChatPersonMenu } from "./TeamChatPersonMenu";

const person: OrganizationPerson = { memberId: "member", userId: "other", name: "Robin Patel", image: null, email: "robin@example.com", role: "member", plan: "pro", joinedAt: 1 };
const identity = { id: person.userId, name: person.name, image: person.image };
const scope = { accountId: "self", spaceId: "team", generation: 1, reach: "live" as const, current: () => true };
const ready: TeamChatStatus = { state: "ready", accountId: "self", spaceId: "team", reach: "live", chat: { features: ["base"], people: [identity], conversations: [] } };
const direct: TeamConversation = {
  id: "direct",
  kind: "dm",
  name: null,
  topic: null,
  private: true,
  members: [identity],
  joined: true,
  lastMessageAt: null,
  canAddMembers: false,
  canRemoveMembers: false,
  createdAt: new Date(0).toISOString(),
  participants: [{ person: identity, inOrganization: true }],
  lastMessageSeq: 0,
  read: null,
};
const origin = { view: "people" as const, spaceId: "team" };
function tree(editable = false) {
  return (
    <QueryClientProvider client={queryClient}>
      <TeamChatContext value={scope}>
        <TeamChatPersonMenu person={person} spaceId="team" editable={editable} onRemove={() => {}} />
      </TeamChatContext>
    </QueryClientProvider>
  );
}
beforeEach(() => {
  queryClient.setQueryData(chatStateKey(scope), ready);
  useRouter.setState({ route: origin, threadIds: [], chatWork: null, history: [], future: [] });
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.restoreAllMocks();
});

it("lets an ordinary member open the same canonical person chat without admin controls", async () => {
  vi.spyOn(core, "call").mockImplementation(async (method) => (method === "teamChat.state" ? ready : direct));
  render(tree());
  fireEvent.click(await screen.findByRole("button", { name: "More for Robin Patel" }));
  const message = await screen.findByRole("menuitem", { name: "Message" });
  expect(screen.queryByRole("menuitem", { name: "Remove member…" })).toBeNull();
  fireEvent.click(message);
  await waitFor(() => expect(useRouter.getState().route).toMatchObject({ view: "team-chat", conversationId: "direct" }));
  expect(core.call).toHaveBeenCalledWith("teamChat.openDm", { spaceId: "team", userIds: ["other"] });
  expect(useRouter.getState().history).toContainEqual(origin);
});

it("keeps People and the Message action after failure so the person can retry", async () => {
  let failed = false;
  vi.spyOn(core, "call").mockImplementation(async (method) => {
    if (method === "teamChat.state") return ready;
    if (!failed) {
      failed = true;
      throw new Error("Chat could not be opened.");
    }
    return direct;
  });
  render(tree());
  fireEvent.click(await screen.findByRole("button", { name: "More for Robin Patel" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Message" }));
  expect((await screen.findByRole("alert")).textContent).toBe("Chat could not be opened.");
  expect(useRouter.getState().route).toEqual(origin);
  fireEvent.click(screen.getByRole("menuitem", { name: "Message" }));
  await waitFor(() => expect(useRouter.getState().route).toMatchObject({ view: "team-chat", conversationId: "direct" }));
});

it("keeps only the existing admin action when this server has no chat", async () => {
  queryClient.setQueryData(chatStateKey(scope), { state: "unavailable" });
  vi.spyOn(core, "call").mockResolvedValue({ state: "unavailable" });
  render(tree(true));
  fireEvent.click(await screen.findByRole("button", { name: "More for Robin Patel" }));
  expect(await screen.findByRole("menuitem", { name: "Remove member…" })).toBeTruthy();
  expect(screen.queryByRole("menuitem", { name: "Message" })).toBeNull();
});
