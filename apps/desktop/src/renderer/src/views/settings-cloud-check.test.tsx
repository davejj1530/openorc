import { CLOUD_CHECK_STEPS, type CloudCheck, type CloudCheckState } from "@openorc/protocol";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { queryClient } from "../lib/client";
import { core } from "../lib/rpc";
import { spaceNavigation } from "../lib/space-navigation";
import { CloudCheckSection } from "./settings-cloud-check";

vi.mock("../lib/rpc", () => ({ core: { call: vi.fn(), onReady: vi.fn(), onPush: () => () => {} } }));

const running = (): CloudCheck => ({
  id: "c1",
  startedAt: Date.now(),
  done: false,
  service: "Vercel",
  broken: null,
  links: CLOUD_CHECK_STEPS.map((step) => ({ step, state: "running", words: null, ms: null })),
});
const finished = (broken?: { step: "codex"; words: string }): CloudCheck => ({
  ...running(),
  done: true,
  broken: broken?.step ?? null,
  links: CLOUD_CHECK_STEPS.map((step) =>
    step === broken?.step
      ? { step, state: "broken", words: broken.words, ms: 1100 }
      : { step, state: step === "opencode" ? "unchecked" : "ok", words: step === "opencode" ? "No keys." : null, ms: 180 },
  ),
});
let state: CloudCheckState;

beforeEach(() => {
  state = { state: "ready", check: null };
  spaceNavigation.setState({ current: null, personal: "personal-1" });
  vi.mocked(core.call).mockImplementation((async (method: string) => {
    if (method === "cloudCheck.read") return state;
    if (method === "cloudCheck.start") return (state = { state: "ready", check: running() });
    if (method === "spaces.status") return { state: "ready", personalSpaceId: "personal-only", spaces: [{ id: "personal-only", kind: "personal" }] };
    return null;
  }) as never);
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.resetAllMocks();
});

const show = () => render(<QueryClientProvider client={queryClient}>{<CloudCheckSection active />}</QueryClientProvider>);

it("is absent where the server runs no check", async () => {
  state = { state: "unavailable" };
  show();
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("cloudCheck.read", {}));
  expect(screen.queryByText("Check")).toBeNull();
});

it("runs a check in the space the person is in, reads it as it goes, and says all is well", async () => {
  show();
  expect(await screen.findByText("Not run yet")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Run check" }));
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("cloudCheck.start", { spaceId: "personal-1" }));
  expect(await screen.findByText("Checking")).toBeTruthy();
  expect((screen.getByRole("button", { name: "Run again" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText("Start a test machine")).toBeTruthy();
  state = { state: "ready", check: finished() };
  expect(await screen.findByText("Everything works", undefined, { timeout: 3_000 })).toBeTruthy();
  expect(screen.getByText("On Vercel")).toBeTruthy();
  expect(screen.getByText("No keys.")).toBeTruthy();
  const untried = screen.getByText("Your OpenCode keys").closest("li")!;
  expect(untried.querySelector(".cloud-check-time")?.textContent, "a link not tried has no time").toBe("");
});

it("runs in Personal for a person with Personal alone, whom the space switcher holds nothing for", async () => {
  spaceNavigation.setState({ current: null, personal: null });
  show();
  const run = await screen.findByRole("button", { name: "Run check" });
  await waitFor(() => expect((run as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(run);
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("cloudCheck.start", { spaceId: "personal-only" }));
});

it("names the broken link with why", async () => {
  state = { state: "ready", check: finished({ step: "codex", words: "ChatGPT ended this sign-in. Sign in with ChatGPT again." }) };
  show();
  expect(await screen.findByText("Broken: Your Codex sign-in")).toBeTruthy();
  expect(screen.getByRole("alert").textContent).toBe("ChatGPT ended this sign-in. Sign in with ChatGPT again.");
  expect((screen.getByRole("button", { name: "Run again" }) as HTMLButtonElement).disabled).toBe(false);
});
