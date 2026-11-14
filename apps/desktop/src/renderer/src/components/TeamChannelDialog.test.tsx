import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { TeamConversation } from "@openorc/protocol";
import { core } from "../lib/rpc";
import { queryClient } from "../lib/client";
import { useRouter } from "../lib/router";
import { TeamChatContext, type TeamChatContextValue } from "../lib/team-chat-context";
import { useTeamChatState } from "../lib/team-chat-queries";
import { TeamChannelDialog } from "./TeamChannelDialog";

const people = [
  { id: "self", name: "Alex Chen", image: null },
  { id: "other", name: "Robin Patel", image: null },
];
const conversation: TeamConversation = {
  id: "review",
  kind: "channel",
  name: "review",
  topic: "Keep this topic",
  private: false,
  members: people,
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
const origin = { view: "people" as const, spaceId: "team" };
function StateRead({ children }: { children: ReactNode }) {
  useTeamChatState();
  return children;
}
function tree(onClose = () => {}) {
  return (
    <QueryClientProvider client={queryClient}>
      <TeamChatContext value={scope}>
        <StateRead>
          <TeamChannelDialog scope={scope} organizationName="Example Studio" people={people} onClose={onClose} />
        </StateRead>
      </TeamChatContext>
    </QueryClientProvider>
  );
}
function fill() {
  fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "Review" } });
  fireEvent.change(screen.getByRole("textbox", { name: "Topic" }), { target: { value: "Keep this topic" } });
}
beforeEach(() => {
  useRouter.setState({ route: origin, threadIds: [], chatWork: null, history: [], future: [] });
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.restoreAllMocks();
});

it("keeps the channel form and audience after a duplicate-name refusal and opens on a deliberate retry", async () => {
  let created = false;
  vi.spyOn(core, "call").mockImplementation(async (method) => {
    if (method === "teamChat.state")
      return { state: "ready", accountId: "self", spaceId: "team", reach: "live", chat: { features: ["base", "channels"], people, conversations: created ? [conversation] : [] } };
    if (!created) {
      created = true;
      throw new Error("#review already exists.");
    }
    return conversation;
  });
  const close = vi.fn();
  render(tree(close));
  expect(screen.getByRole("button", { name: "Public Everyone in Example Studio" }).getAttribute("aria-pressed")).toBe("true");
  fill();
  fireEvent.click(screen.getByRole("button", { name: "Create channel" }));
  await screen.findByRole("alert");
  expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Name" }).value).toBe("Review");
  expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Topic" }).value).toBe("Keep this topic");
  expect(useRouter.getState().route).toEqual(origin);
  fireEvent.click(screen.getByRole("button", { name: "Create channel" }));
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(useRouter.getState().route).toMatchObject({ view: "team-chat", spaceId: "team", conversationId: "review" });
  expect(core.call).toHaveBeenCalledWith("teamChat.createChannel", { spaceId: "team", name: "review", topic: "Keep this topic", private: false, userIds: [] });
});

it.each(["dismiss", "space change"] as const)("does not reopen a created channel after %s", async (change) => {
  let finish = (_value: TeamConversation) => {};
  const delayed = new Promise<TeamConversation>((resolve) => {
    finish = resolve;
  });
  vi.spyOn(core, "call").mockImplementation(async (method) =>
    method === "teamChat.createChannel"
      ? delayed
      : { state: "ready", accountId: "self", spaceId: "team", reach: "live", chat: { features: ["base", "channels"], people, conversations: [conversation] } },
  );
  const close = vi.fn();
  const view = render(tree(close));
  fill();
  fireEvent.click(screen.getByRole("button", { name: "Create channel" }));
  await screen.findByRole("button", { name: "Creating…" });
  if (change === "dismiss") view.unmount();
  else
    act(() => {
      useRouter.getState().navigate({ view: "people", spaceId: "other-team" });
    });
  await act(async () => {
    finish(conversation);
    await delayed;
  });
  expect(useRouter.getState().route).toEqual(change === "dismiss" ? origin : { view: "people", spaceId: "other-team" });
  expect(close).not.toHaveBeenCalled();
});

it("lets Cancel keep the opener without creating anything", () => {
  vi.spyOn(core, "call").mockResolvedValue({ state: "unavailable" });
  const close = vi.fn();
  render(tree(close));
  fill();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(close).toHaveBeenCalledOnce();
  expect(core.call).not.toHaveBeenCalledWith("teamChat.createChannel", expect.anything());
  expect(useRouter.getState().route).toEqual(origin);
});
it("opens the successful creation even if a later roster refresh fails", async () => {
  let created = false;
  vi.spyOn(core, "call").mockImplementation(async (method) => {
    if (method === "teamChat.createChannel") {
      created = true;
      return conversation;
    }
    if (created) throw new Error("OpenOrc Cloud can't be reached.");
    return { state: "ready", accountId: "self", spaceId: "team", reach: "live", chat: { features: ["base", "channels"], people, conversations: [] } };
  });
  render(tree());
  fill();
  fireEvent.click(screen.getByRole("button", { name: "Create channel" }));
  await waitFor(() => expect(useRouter.getState().route).toMatchObject({ view: "team-chat", conversationId: "review" }));
  expect(core.call).toHaveBeenCalledWith("teamChat.createChannel", expect.anything());
});
