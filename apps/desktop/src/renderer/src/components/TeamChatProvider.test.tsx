import { StrictMode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { SpacesStatus } from "@openorc/protocol";
import { core } from "../lib/rpc";
import { queryClient } from "../lib/client";
import { spaceNavigation } from "../lib/space-navigation";
import { organizationContentGate } from "../lib/organization-content-gate";
import { useTeamChatContext } from "../lib/team-chat-context";
import { TeamChatProvider } from "./TeamChatProvider";

function Probe() {
  const scope = useTeamChatContext();
  return <div>{scope?.current() ? `Allowed ${scope.spaceId}` : "Closed"}</div>;
}
afterEach(() => {
  cleanup();
  organizationContentGate.reset();
  queryClient.clear();
  vi.restoreAllMocks();
});

it("uses the shared gate through strict mount, Personal and an organization return", async () => {
  vi.spyOn(core, "call").mockImplementation(
    async () =>
      ({
        state: "ready",
        userId: "self",
        apiOrigin: "https://example.com",
        personalSpaceId: "personal",
        spaces: [
          { id: "personal", kind: "personal" },
          { id: "team", kind: "organization", name: "Team", logo: null, memberId: "member", role: "member", memberCount: 1 },
        ],
        reach: "live",
        heardAt: Date.now(),
        error: null,
        invitations: [],
        create: { allowed: true, reason: null },
        organizationAccess: { state: "active", reason: null, until: null, message: null },
      }) satisfies SpacesStatus,
  );
  spaceNavigation.setState({ key: "account", current: "team" });
  render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <TeamChatProvider>
          <Probe />
        </TeamChatProvider>
      </QueryClientProvider>
    </StrictMode>,
  );
  await screen.findByText("Allowed team");
  act(() => spaceNavigation.setState({ current: "personal" }));
  expect(screen.getByText("Closed")).toBeTruthy();
  act(() => spaceNavigation.setState({ current: "team" }));
  await screen.findByText("Allowed team");
});
