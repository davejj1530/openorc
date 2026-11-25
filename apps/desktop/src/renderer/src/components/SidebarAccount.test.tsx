import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { AccountStatus } from "@openorc/protocol";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SidebarAccount } from "./SidebarAccount";
import { queryClient } from "../lib/client";
import { core } from "../lib/rpc";
import { useRouter } from "../lib/router";

vi.mock("../lib/rpc", () => ({ core: { call: vi.fn(), onReady: vi.fn(), onPush: () => () => {} } }));
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
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
    github: null,
    connectingGithub: null,
    paying: null,
    projects: [],
    error: null,
  });
  const button = await screen.findByRole("button", { name: "Theo Laurent Pro · 41 h left" });
  expect(screen.getByText("TL")).toBeTruthy();
  fireEvent.click(button);
  expect(useRouter.getState().route).toEqual({ view: "settings", section: "account" });
});

it("signs in through the browser while signed out, says it waits, and calls it off", async () => {
  const page = "http://localhost:3600/sign-in?request=r1";
  let status: AccountStatus = { state: "signed-out", signingIn: null, ended: false, error: null };
  vi.mocked(core.call).mockImplementation(async (method: string) => {
    if (method === "account.signIn") status = { state: "signed-out", signingIn: { state: "waiting", page }, ended: false, error: null };
    if (method === "account.signIn.cancel") status = { state: "signed-out", signingIn: null, ended: false, error: null };
    return status;
  });
  render(
    <QueryClientProvider client={queryClient}>
      <footer>
        <SidebarAccount />
      </footer>
    </QueryClientProvider>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Sign in" }));
  expect(await screen.findByRole("button", { name: "Signing in…" })).toBeTruthy();
  expect(core.call).toHaveBeenCalledWith("account.signIn", {});
  fireEvent.click(screen.getByRole("button", { name: "Cancel signing in" }));
  expect(await screen.findByRole("button", { name: "Sign in" })).toBeTruthy();
  expect(core.call).toHaveBeenCalledWith("account.signIn.cancel", {});
});

it("says why a sign-in failed under Sign in", async () => {
  show({ state: "signed-out", signingIn: { state: "failed", error: "OpenOrc Cloud can't be reached." }, ended: false, error: null });
  expect(await screen.findByRole("button", { name: "Sign in OpenOrc Cloud can't be reached." })).toBeTruthy();
});

it("shows nothing in a build with no account server", async () => {
  show({ state: "unavailable" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(screen.queryByRole("button")).toBeNull();
});
