import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { queryClient } from "../lib/client";
import { core } from "../lib/rpc";
import { useRouter } from "../lib/router";
import { HostedConversationBoundary } from "./HostedConversationBoundary";
import { UsageRecovery } from "./UsageRecovery";
import { cloudReviewThread, localReviewThread } from "./test-fixtures/hosted-review";

beforeEach(() => {
  vi.spyOn(core, "call").mockImplementation((async (method: string) => (method === "hosted.capabilities" ? { version: 1, features: {} } : null)) as never);
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.restoreAllMocks();
});

const show = (thread: typeof cloudReviewThread) =>
  render(
    <QueryClientProvider client={queryClient}>
      <HostedConversationBoundary thread={thread}>
        <UsageRecovery provider="codex" lead="Usage limit reached." />
      </HostedConversationBoundary>
    </QueryClientProvider>,
  );

it("leads from a limit in a cloud thread to the person's accounts on OpenOrc Cloud, never this Mac's usage or resets", () => {
  show({ ...cloudReviewThread, agent: "codex" });
  fireEvent.click(screen.getByRole("button", { name: "Manage usage" }));
  expect(useRouter.getState().route).toEqual({ view: "settings", section: "cloud" });
  expect(core.call).not.toHaveBeenCalledWith("providers.usage", expect.anything());
});

it("leads from a limit in a thread of this Mac to its usage settings for the agent", () => {
  show({ ...localReviewThread, agent: "claude" });
  fireEvent.click(screen.getByRole("button", { name: "Manage usage" }));
  expect(useRouter.getState().route).toEqual({ view: "settings", section: "usage", provider: "codex" });
});
