import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { CloudSignIn, CloudSignIns } from "@openorc/protocol";
import { afterEach, expect, it, vi } from "vitest";
import { CloudSignInsSection } from "./settings-cloud-sign-ins";
import { queryClient } from "../lib/client";
import { core } from "../lib/rpc";
import { useTheme } from "../lib/theme";

vi.mock("../lib/rpc", () => ({ core: { call: vi.fn(), onReady: vi.fn(), onPush: () => () => {} } }));
afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.resetAllMocks();
});

const rows: CloudSignIn[] = [
  { kind: "claude", accountId: "claude-cli", label: "Personal", state: "ready", way: "browser", error: null },
  { kind: "claude", accountId: "work", label: "Work", state: "missing", way: "private-window", error: null },
  { kind: "codex", label: "Codex", state: "missing", way: "copy", error: null },
  { kind: "opencode", provider: "anthropic", label: "Anthropic", state: "missing", way: "key", error: null },
  { kind: "opencode", provider: "openrouter", label: "OpenRouter", state: "failed", way: "copy", error: "Cannot access protected storage for OpenCode's cloud keys." },
];

async function show(signIns: CloudSignIns) {
  vi.mocked(core.call).mockImplementation((async () => signIns) as never);
  render(
    <QueryClientProvider client={queryClient}>
      <CloudSignInsSection active />
    </QueryClientProvider>,
  );
  await screen.findByText("Sign-ins for the cloud");
}

const row = (label: string) => screen.getByText(label, { selector: ".settings-field > span > span:first-child" }).closest(".settings-field") as HTMLElement;

it.each(["light", "dark"] as const)("lists each sign-in, ready or how it gets ready, in %s", async (theme) => {
  act(() => void useTheme.getState().set(theme));
  await show({ rows, bringing: false });
  expect(within(row("Claude · Personal")).getByText("Ready")).toBeTruthy();
  expect(within(row("Claude · Work")).getByText("In a private window")).toBeTruthy();
  expect(within(row("Codex")).getByText("From this Mac")).toBeTruthy();
  expect(within(row("OpenCode · Anthropic")).getByText("Needs an API key")).toBeTruthy();
  expect(within(row("OpenCode · OpenRouter")).getByRole("alert").textContent).toBe("Cannot access protected storage for OpenCode's cloud keys.");
  // The one typed in is not counted: no step brings it.
  expect(within(row("Sign-ins")).getByText("3 missing")).toBeTruthy();
});

it("copies this Mac's keys only after a yes, and brings the browser sign-ins either way", async () => {
  await show({ rows, bringing: false });
  fireEvent.click(screen.getByRole("button", { name: "Bring them" }));
  expect(screen.getByText("The cloud gets a copy of Codex's API key and OpenCode's OpenRouter key.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Copy" }));
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("cloud.signIns.bringAll", { copy: true }));
  fireEvent.click(screen.getByRole("button", { name: "Bring them" }));
  fireEvent.click(screen.getByRole("button", { name: "Don't copy" }));
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("cloud.signIns.bringAll", { copy: false }));
});

it("brings browser sign-ins without asking when nothing is copied", async () => {
  await show({ rows: rows.filter((each) => each.way !== "copy"), bringing: false });
  fireEvent.click(screen.getByRole("button", { name: "Bring them" }));
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("cloud.signIns.bringAll", { copy: false }));
  expect(screen.queryByText(/The cloud gets a copy/)).toBeNull();
});

it("shows the sign-in under way, and stops after it when cancelled", async () => {
  await show({ rows: [rows[0]!, { ...rows[1]!, state: "working" }], bringing: true });
  expect(within(row("Claude · Work")).getByText("Sign in in the private window that opened.")).toBeTruthy();
  expect(within(row("Claude · Work")).getByText("Waiting for sign-in")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("cloud.signIns.cancel", {}));
});

it("offers no step once every sign-in is ready", async () => {
  await show({ rows: [rows[0]!], bringing: false });
  expect(screen.queryByRole("button", { name: "Bring them" })).toBeNull();
});
