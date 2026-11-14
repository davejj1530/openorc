import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import type { TeamChatRow } from "@openorc/client";
import type { TeamConversation } from "@openorc/protocol";
import { core } from "./rpc";
import { queryClient } from "./client";
import { useRouter } from "./router";
import { TeamChatContext, type TeamChatContextValue } from "./team-chat-context";
import { useOpenTeamChat } from "./team-chat-open";

const person = { id: "other", name: "Alex Chen", image: null };
const row: TeamChatRow = { kind: "person", id: person.id, title: person.name, person, conversation: null };
const conversation: TeamConversation = {
  id: "direct",
  kind: "dm",
  name: null,
  topic: null,
  private: true,
  members: [person],
  joined: true,
  lastMessageAt: null,
  canAddMembers: false,
  canRemoveMembers: false,
  createdAt: new Date(0).toISOString(),
  participants: [{ person, inOrganization: true }],
  lastMessageSeq: 0,
  read: null,
};
const scope: TeamChatContextValue = { accountId: "self", spaceId: "team", generation: 1, reach: "live", current: () => true };
const origin = { view: "people" as const, spaceId: "team" };
const wrapper = ({ children }: { children: ReactNode }) => <TeamChatContext value={scope}>{children}</TeamChatContext>;
function delayed() {
  let finish = (_value: TeamConversation) => {};
  const promise = new Promise<TeamConversation>((resolve) => {
    finish = resolve;
  });
  vi.spyOn(core, "call").mockReturnValue(promise);
  return finish;
}
beforeEach(() => useRouter.setState({ route: origin, threadIds: [], chatWork: null, history: [], future: [] }));
afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.restoreAllMocks();
});

it("does not reopen a dismissed entry when the person lookup arrives", async () => {
  const finish = delayed();
  const hook = renderHook(useOpenTeamChat, { wrapper });
  let opening: Promise<boolean> | undefined;
  act(() => {
    opening = hook.result.current.open(row);
  });
  hook.unmount();
  await act(async () => {
    finish(conversation);
    await opening;
  });
  expect(useRouter.getState().route).toEqual(origin);
});
it("keeps a newer destination when a person lookup arrives", async () => {
  const finish = delayed();
  const hook = renderHook(useOpenTeamChat, { wrapper });
  let opening: Promise<boolean> | undefined;
  act(() => {
    opening = hook.result.current.open(row);
  });
  act(() => useRouter.getState().navigate({ view: "tasks" }));
  await act(async () => {
    finish(conversation);
    await opening;
  });
  expect(useRouter.getState().route).toEqual({ view: "tasks" });
});
it("does not carry a failed person's retry into a different space", async () => {
  vi.spyOn(core, "call").mockRejectedValue(new Error("Chat could not be opened."));
  let currentScope = scope;
  const hook = renderHook(useOpenTeamChat, { wrapper: ({ children }) => <TeamChatContext value={currentScope}>{children}</TeamChatContext> });
  await act(async () => {
    await hook.result.current.open(row);
  });
  expect(hook.result.current.error).toBe("Chat could not be opened.");
  currentScope = { ...scope, spaceId: "another", generation: 2 };
  hook.rerender();
  expect(hook.result.current.error).toBeNull();
  await act(async () => {
    expect(await hook.result.current.retry()).toBe(false);
  });
  expect(core.call).toHaveBeenCalledTimes(1);
});
it("keeps the origin on failure and opens the canonical conversation on retry", async () => {
  vi.spyOn(core, "call").mockRejectedValueOnce(new Error("Chat could not be opened.")).mockResolvedValue(conversation);
  const hook = renderHook(useOpenTeamChat, { wrapper });
  await act(async () => {
    expect(await hook.result.current.open(row)).toBe(false);
  });
  expect(useRouter.getState().route).toEqual(origin);
  await act(async () => {
    expect(await hook.result.current.retry()).toBe(true);
  });
  expect(useRouter.getState().route).toEqual({ view: "team-chat", accountId: "self", spaceId: "team", conversationId: "direct" });
  expect(core.call).toHaveBeenNthCalledWith(2, "teamChat.openDm", { spaceId: "team", userIds: [person.id] });
});
