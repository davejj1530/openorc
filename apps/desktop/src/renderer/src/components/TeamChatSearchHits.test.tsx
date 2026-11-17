import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { Command } from "cmdk";
import type { TeamChatSearch, TeamChatStatus, TeamConversation } from "@openorc/protocol";
import { core } from "../lib/rpc";
import { queryClient } from "../lib/client";
import { TeamChatContext, type TeamChatContextValue } from "../lib/team-chat-context";
import { useTeamChatJump } from "../lib/team-chat-jump";
import { useRouter } from "../lib/router";
import { TeamChatSearchHits } from "./TeamChatSearchHits";

const self = { id: "self", name: "Alex Chen", image: null };
const mara = { id: "mara", name: "Mara Okafor", image: null };
const general: TeamConversation = {
  id: "general",
  kind: "channel",
  name: "general",
  topic: null,
  private: false,
  members: [self, mara],
  joined: true,
  lastMessageAt: null,
  canAddMembers: false,
  canRemoveMembers: false,
  createdAt: new Date(0).toISOString(),
  participants: null,
  lastMessageSeq: 9,
  read: null,
};
const scope: TeamChatContextValue = { accountId: "self", spaceId: "team", generation: 1, reach: "live", current: () => true };
const status = (features: string[]): TeamChatStatus => ({
  state: "ready",
  accountId: "self",
  spaceId: "team",
  reach: "live",
  chat: { features: features as never, people: [self, mara], conversations: [general] },
});
const found: TeamChatSearch = {
  hits: [{ id: "m4", channelId: "general", seq: 4, person: mara, snippet: { text: "The zephyr release goes out Thursday.", marks: [[4, 10]] }, files: [], createdAt: new Date().toISOString() }],
  more: false,
};
const tree = (query: string, onOpened = vi.fn()) => (
  <QueryClientProvider client={queryClient}>
    <TeamChatContext value={scope}>
      <Command shouldFilter={false}>
        <Command.List>
          <TeamChatSearchHits query={query} onOpened={onOpened} />
        </Command.List>
      </Command>
    </TeamChatContext>
  </QueryClientProvider>
);
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  queryClient.clear();
  vi.restoreAllMocks();
});

it("lists matching chat messages with who wrote them and where, and opens one in place", async () => {
  const call = vi.spyOn(core, "call").mockImplementation(async (method) => (method === "teamChat.state" ? status(["base", "search"]) : found));
  const onOpened = vi.fn();
  render(tree("zeph", onOpened));
  const hit = await screen.findByText("The zephyr release goes out Thursday.");
  expect(screen.getByText("#general")).toBeTruthy();
  expect(call).toHaveBeenCalledWith("teamChat.search", { spaceId: "team", q: "zeph" });
  fireEvent.click(hit);
  expect(useTeamChatJump.getState().jump).toMatchObject({ id: "m4", seq: 4 });
  expect(useRouter.getState().route).toMatchObject({ view: "team-chat", conversationId: "general" });
  expect(onOpened).toHaveBeenCalled();
});

it("asks nothing for one character or where the server has no chat search", async () => {
  const call = vi.spyOn(core, "call").mockImplementation(async (method) => (method === "teamChat.state" ? status(["base"]) : found));
  const view = render(tree("zeph"));
  await waitFor(() => expect(call).toHaveBeenCalledWith("teamChat.state", { spaceId: "team" }));
  view.unmount();
  queryClient.clear();
  call.mockImplementation(async (method) => (method === "teamChat.state" ? status(["base", "search"]) : found));
  render(tree("z"));
  await waitFor(() => expect(call.mock.calls.filter(([method]) => method === "teamChat.state").length).toBeGreaterThan(1));
  expect(call.mock.calls.some(([method]) => method === "teamChat.search")).toBe(false);
  expect(screen.queryByText("Chat messages")).toBeNull();
});

it("says when the search failed and searches again on request", async () => {
  let fail = true;
  vi.spyOn(core, "call").mockImplementation(async (method) => {
    if (method === "teamChat.state") return status(["base", "search"]);
    if (fail) throw new Error("OpenOrc Cloud can't be reached.");
    return found;
  });
  render(tree("zephyr"));
  expect(await screen.findByText("OpenOrc Cloud can't be reached.")).toBeTruthy();
  fail = false;
  fireEvent.click(screen.getByText("Try again"));
  expect(await screen.findByText("The zephyr release goes out Thursday.")).toBeTruthy();
});
