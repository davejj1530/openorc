import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { TeamChatStatus } from "@openorc/protocol";
import { core } from "../lib/rpc";
import { queryClient } from "../lib/client";
import { TeamChatContext, type TeamChatContextValue } from "../lib/team-chat-context";
import { TeamChatFace } from "./TeamChatFace";

const self = { id: "self", name: "Alex Chen", image: null };
const mara = { id: "mara", name: "Mara Okafor", image: null };
const nia = { id: "nia", name: "Nia Rivera", image: null };
const status = (features: string[]): TeamChatStatus => ({
  state: "ready",
  accountId: "self",
  spaceId: "team",
  reach: "live",
  chat: { features: features as never, people: [self, mara, nia], conversations: [] },
});
const scope = (reach: "live" | "offline" = "live"): TeamChatContextValue => ({ accountId: "self", spaceId: "team", generation: 1, reach, current: () => true });
const tree = (value: TeamChatContextValue) => (
  <QueryClientProvider client={queryClient}>
    <TeamChatContext value={value}>
      <TeamChatFace people={[mara, nia]} />
    </TeamChatContext>
  </QueryClientProvider>
);
afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.restoreAllMocks();
});
function serve(features: string[]) {
  return vi.spyOn(core, "call").mockImplementation(async (method) => {
    if (method === "teamChat.state") return status(features);
    if (method === "teamChat.presence")
      return {
        people: [
          { id: "mara", state: "connected" },
          { id: "nia", state: "not-connected" },
          { id: "self", state: "connected" },
        ],
      };
    return {};
  });
}

it("marks only a person with an app connected, and says so on demand", async () => {
  serve(["base", "presence"]);
  render(tree(scope()));
  const dot = await screen.findByRole("img", { name: "Connected to OpenOrc" });
  expect(dot.closest(".team-chat-face")?.textContent).toBe("MO");
  expect(screen.getAllByRole("img", { name: "Connected to OpenOrc" })).toHaveLength(1);
});

it("marks nobody offline, where presence can't be known, and asks nothing of a server without it", async () => {
  const offline = serve(["base", "presence"]);
  render(tree(scope("offline")));
  await waitFor(() => expect(offline).toHaveBeenCalledWith("teamChat.state", { spaceId: "team" }));
  expect(offline.mock.calls.some(([method]) => method === "teamChat.presence")).toBe(false);
  cleanup();
  queryClient.clear();
  const without = serve(["base"]);
  render(tree(scope()));
  await waitFor(() => expect(without).toHaveBeenCalledWith("teamChat.state", { spaceId: "team" }));
  expect(without.mock.calls.some(([method]) => method === "teamChat.presence")).toBe(false);
  expect(screen.queryByRole("img", { name: "Connected to OpenOrc" })).toBeNull();
});
