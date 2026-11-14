import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { TeamConversation } from "@openorc/protocol";
import { core } from "../lib/rpc";
import { queryClient } from "../lib/client";
import { useRouter } from "../lib/router";
import { TeamChatContext, type TeamChatContextValue } from "../lib/team-chat-context";
import { TeamGroupDialog, type TeamGroupDialogProps } from "./TeamGroupDialog";

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
  members: people,
  participants: people.map((person) => ({ person, inOrganization: true })),
  joined: true,
  canAddMembers: false,
  canRemoveMembers: false,
  createdAt: new Date(0).toISOString(),
  lastMessageSeq: 0,
  lastMessageAt: null,
  read: null,
};
const scope: TeamChatContextValue = { accountId: "self", spaceId: "team", generation: 1, reach: "live", current: () => true };
const origin = { view: "people" as const, spaceId: "team" };
function tree(props: Partial<TeamGroupDialogProps> = {}) {
  return (
    <QueryClientProvider client={queryClient}>
      <TeamChatContext value={scope}>
        <TeamGroupDialog scope={scope} people={people} onClose={() => {}} {...props} />
      </TeamChatContext>
    </QueryClientProvider>
  );
}
function choose() {
  fireEvent.click(screen.getByRole("checkbox", { name: "Robin Patel" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Casey Morgan" }));
}
beforeEach(() => {
  useRouter.setState({ route: origin, threadIds: [], chatWork: null, history: [], future: [] });
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.restoreAllMocks();
  localStorage.clear();
});

it("opens the fixed selection once and keeps both selections after a refusal", async () => {
  let refused = false;
  vi.spyOn(core, "call").mockImplementation(async () => {
    if (!refused) {
      refused = true;
      throw new Error("Chat could not be opened.");
    }
    return group;
  });
  render(tree());
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Open chat" }).disabled).toBe(true);
  choose();
  fireEvent.click(screen.getByRole("button", { name: "Open chat" }));
  expect((await screen.findByRole("alert")).textContent).toBe("Chat could not be opened.");
  expect(screen.getAllByRole("checkbox", { checked: true })).toHaveLength(2);
  expect(useRouter.getState().route).toEqual(origin);
  fireEvent.click(screen.getByRole("button", { name: "Open chat" }));
  await waitFor(() => expect(useRouter.getState().route).toMatchObject({ view: "team-chat", conversationId: "group" }));
  expect(core.call).toHaveBeenLastCalledWith("teamChat.openDm", { spaceId: "team", userIds: ["one", "two"] });
});
it("never offers self or duplicate identities and caps selection at eight others", () => {
  const many = Array.from({ length: 9 }, (_, i) => ({ id: `person-${i}`, name: `Person ${i}`, image: null }));
  render(tree({ people: [people[0]!, ...many, ...many] }));
  expect(screen.getAllByRole("checkbox")).toHaveLength(9);
  for (let i = 0; i < 8; i++) fireEvent.click(screen.getByRole("checkbox", { name: `Person ${i}` }));
  expect(screen.getByRole<HTMLInputElement>("checkbox", { name: "Person 8" }).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Remove Person 0" }));
  expect(screen.getByRole<HTMLInputElement>("checkbox", { name: "Person 8" }).disabled).toBe(false);
});
it("drops a departed selection before submitting and does not select them again on return", () => {
  const view = render(tree());
  choose();
  view.rerender(tree({ people: people.filter((person) => person.id !== "two") }));
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Open chat" }).disabled).toBe(true);
  view.rerender(tree());
  expect(screen.getByRole<HTMLInputElement>("checkbox", { name: "Casey Morgan" }).checked).toBe(false);
});
it("offers the existing invitation flow only when supplied for an empty organization", () => {
  const invite = vi.fn();
  const view = render(tree({ people: [people[0]!], onInvite: invite }));
  expect(screen.getByText("No one else is here yet.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Invite people" }));
  expect(invite).toHaveBeenCalledOnce();
  view.rerender(tree({ people: [] }));
  expect(screen.queryByRole("button", { name: "Invite people" })).toBeNull();
});
it("does not move a later destination when the group request finishes", async () => {
  let finish = (_value: TeamConversation) => {};
  const delayed = new Promise<TeamConversation>((resolve) => {
    finish = resolve;
  });
  vi.spyOn(core, "call").mockReturnValue(delayed);
  const close = vi.fn();
  render(tree({ onClose: close }));
  choose();
  fireEvent.click(screen.getByRole("button", { name: "Open chat" }));
  await screen.findByRole("button", { name: "Opening…" });
  const next = { view: "people" as const, spaceId: "other" };
  act(() => useRouter.getState().navigate(next));
  await act(async () => {
    finish(group);
    await delayed;
  });
  expect(useRouter.getState().route).toEqual(next);
  expect(close).not.toHaveBeenCalled();
});
