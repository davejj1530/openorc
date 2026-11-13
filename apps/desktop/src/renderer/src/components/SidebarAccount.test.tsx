import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { AccountStatus } from "@openorc/protocol";
import { afterEach, expect, it, vi } from "vitest";
import { SidebarAccount } from "./SidebarAccount";
import { queryClient } from "../lib/client";
import { core } from "../lib/rpc";
import { useRouter } from "../lib/router";

vi.mock("../lib/rpc", () => ({ core: { call: vi.fn(), onReady: vi.fn(), onPush: () => () => {} } }));
afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.resetAllMocks();
});

function show(status: AccountStatus) {
  vi.mocked(core.call).mockResolvedValue(status);
  render(
    <QueryClientProvider client={queryClient}>
      <footer>
        <SidebarAccount />
      </footer>
    </QueryClientProvider>,
  );
}

it("shows the signed-in person with their plan and cloud hours, and opens Settings > Account", async () => {
  show({
    state: "signed-in",
    email: "theo@example.com",
    name: "Theo Laurent",
    image: null,
    reach: "live",
    plan: { pro: true, standing: "live", at: Date.now() + 86_400_000 },
    hours: { leftSeconds: 41 * 3600 + 120, monthly: null, packsLeftSeconds: 41 * 3600 + 120 },
    sandbox: null,
    signIns: null,
    signingIn: {},
    error: null,
  });
  const button = await screen.findByRole("button", { name: "Theo Laurent Pro · 41 h left" });
  expect(screen.getByText("TL")).toBeTruthy();
  fireEvent.click(button);
  expect(useRouter.getState().route).toEqual({ view: "settings", section: "account" });
});

it("shows nothing while signed out", async () => {
  show({ state: "signed-out", codeSentTo: null, ended: false, error: null });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(screen.queryByRole("button")).toBeNull();
});
