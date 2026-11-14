import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { TeamConversation } from "@openorc/protocol";
import { core } from "../lib/rpc";
import { queryClient } from "../lib/client";
import type { TeamChatContextValue } from "../lib/team-chat-context";
import { useRouter } from "../lib/router";
import { useThreadTabs } from "../lib/thread-tabs";
import { TeamChannelDetails } from "./TeamChannelDetails";
import { TeamChannelLeave } from "./TeamChannelLeave";

const people = [
  { id: "self", name: "Alex Chen", image: null },
  { id: "other", name: "Robin Patel", image: null },
  { id: "third", name: "Morgan Diaz", image: null },
];
const conversation: TeamConversation = {
  id: "planning",
  kind: "channel",
  name: "planning",
  topic: "Review the detailed proposal before publishing.",
  private: true,
  members: people.slice(0, 2),
  joined: true,
  lastMessageAt: null,
  canAddMembers: true,
  canRemoveMembers: true,
  createdAt: new Date(0).toISOString(),
  participants: null,
  lastMessageSeq: 0,
  read: null,
};
const scope: TeamChatContextValue = { accountId: "self", spaceId: "team", generation: 1, reach: "live", current: () => true };
const tree = (current = conversation) => (
  <QueryClientProvider client={queryClient}>
    <TeamChannelDetails scope={scope} conversation={current} people={people} onClose={() => {}} />
  </QueryClientProvider>
);
afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.restoreAllMocks();
});

it("removes stale management controls as soon as the current channel projection loses them", async () => {
  vi.spyOn(core, "call").mockResolvedValue(conversation);
  const view = render(tree());
  await screen.findByRole("button", { name: "Remove Robin Patel" });
  view.rerender(tree({ ...conversation, canRemoveMembers: false, canAddMembers: false }));
  expect(screen.queryByRole("button", { name: "Remove Robin Patel" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Add people" })).toBeNull();
  expect(screen.getByText("Only people added")).toBeTruthy();
});

it("offers only people outside the channel and keeps a refused selection", async () => {
  vi.spyOn(core, "call").mockImplementation(async (method) => {
    if (method === "teamChat.addMembers") throw new Error("Only people in this organization can be in its conversations.");
    return conversation;
  });
  render(tree());
  fireEvent.click(await screen.findByRole("button", { name: "Add people" }));
  const dialog = screen.getByRole("dialog", { name: "Add people" });
  expect(within(dialog).getAllByRole("checkbox")).toHaveLength(1);
  expect(within(dialog).queryByText("Robin Patel")).toBeNull();
  fireEvent.click(within(dialog).getByRole("checkbox"));
  fireEvent.click(within(dialog).getByRole("button", { name: "Add people" }));
  await within(dialog).findByRole("alert");
  expect(within(dialog).getByRole<HTMLInputElement>("checkbox").checked).toBe(true);
  expect(core.call).toHaveBeenCalledWith("teamChat.addMembers", { spaceId: "team", conversationId: "planning", userIds: ["third"] });
});

it("closes only the left channel when its response arrives after the dialog was removed", async () => {
  let finish = () => {};
  const response = new Promise<Record<string, never>>((resolve) => {
    finish = () => resolve({});
  });
  vi.spyOn(core, "call").mockReturnValue(response);
  const route = { view: "team-chat" as const, accountId: "self", spaceId: "team", conversationId: "planning" };
  useThreadTabs.setState({
    tabs: [
      { id: "left", route },
      { id: "work", route: { view: "thread", threadId: "work-thread" } },
    ],
    leaving: [],
    active: "left",
  });
  useRouter.setState({ route, threadIds: [], history: [], future: [] });
  const view = render(<TeamChannelLeave scope={scope} conversation={conversation} onCancel={() => {}} onLeft={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "Leave channel" }));
  await screen.findByRole("button", { name: "Leaving…" });
  view.unmount();
  act(() => useThreadTabs.getState().select("work"));
  await act(async () => {
    finish();
    await response;
  });
  await waitFor(() => expect(useThreadTabs.getState().leaving).toContain("left"));
  expect(useThreadTabs.getState().active).toBe("work");
  expect(useRouter.getState().route).toEqual({ view: "thread", threadId: "work-thread" });
});
