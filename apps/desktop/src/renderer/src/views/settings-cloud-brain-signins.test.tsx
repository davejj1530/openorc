import type { ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { CloudBrainSignIns, CloudBrainStatus } from "@openorc/protocol";
import { afterEach, expect, it, vi } from "vitest";
import { CloudBrainSection } from "./settings-cloud-brain";
import { queryClient } from "../lib/client";
import { core } from "../lib/rpc";

vi.mock("../lib/rpc", () => ({ core: { call: vi.fn(), onReady: vi.fn(), onPush: () => () => {} } }));
vi.mock("../components/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../components/ui")>()),
  Tooltip: ({ label, children }: { label: string; children: ReactNode }) => <span data-tooltip={label}>{children}</span>,
}));
afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.resetAllMocks();
});

const ready: CloudBrainStatus = { state: "ready", region: "sin1", machine: "awake", claude: ["Personal"], behind: false, working: null, door: null, threads: 0, error: null };
const none: CloudBrainSignIns = {
  codex: { mode: null, email: null, plan: null, signingIn: false, pending: null, error: null },
  github: { on: false, blocked: null, behind: false },
  push: { has: false, behind: false },
};

function show(signIns: CloudBrainSignIns, status: CloudBrainStatus = ready) {
  vi.mocked(core.call).mockImplementation(async (method: string) => {
    if (method === "cloud.brain.projects") return [] as never;
    if (method === "cloud.brain.cost") return null as never;
    if (method === "cloud.brain.phones") return [] as never;
    if (method.startsWith("cloud.brain.codex.") || method === "cloud.brain.github" || method === "cloud.brain.signIns") return signIns as never;
    return status as never;
  });
  render(
    <QueryClientProvider client={queryClient}>
      <CloudBrainSection active />
    </QueryClientProvider>,
  );
}

const row = (label: string) => screen.getByText(label, { selector: ".settings-field > span > span:first-child" }).closest(".settings-field") as HTMLElement;
const github = () => screen.getByRole("switch", { name: "GitHub" }) as HTMLInputElement;

it("lists what the brain signs in with besides Claude, quietly, and no notifications row before it has a push key", async () => {
  show({ ...none, codex: { ...none.codex, mode: "chatgpt", email: "brain@example.com", plan: "pro" }, github: { on: true, blocked: null, behind: false }, push: { has: true, behind: false } });
  await screen.findByText("Codex");
  expect(within(row("Codex")).getByText("brain@example.com · ChatGPT Pro")).toBeTruthy();
  expect(github().checked).toBe(true);
  expect(within(row("Notifications")).getByText("On")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Send" })).toBeNull();

  cleanup();
  queryClient.clear();
  show(none);
  await screen.findByText("Codex");
  expect(within(row("Codex")).getByText("None")).toBeTruthy();
  expect(github().checked).toBe(false);
  expect(screen.queryByText("Notifications")).toBeNull();
});

it("signs the brain in to Codex from here in the browser, or with an API key", async () => {
  show(none);
  fireEvent.click(await screen.findByRole("button", { name: "Sign in" }));
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("cloud.brain.codex.signIn", {}));
  fireEvent.click(screen.getByRole("button", { name: "Use an API key" }));
  fireEvent.change(screen.getByPlaceholderText("Paste key"), { target: { value: " sk-fixture-0123456789 " } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("cloud.brain.codex.apiKey", { key: "sk-fixture-0123456789" }));
});

it("waits for the browser with a way to cancel, and offers Send only for what this Mac has not handed over", async () => {
  show({ ...none, codex: { ...none.codex, signingIn: true }, push: { has: true, behind: true } });
  expect(await screen.findByText("Waiting for sign-in")).toBeTruthy();
  expect(within(row("Codex")).getByText("Sign in to ChatGPT in the browser that opened.")).toBeTruthy();
  fireEvent.click(within(row("Codex")).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("cloud.brain.codex.cancel", {}));
  expect(within(row("Codex")).queryByRole("button", { name: "Send" })).toBeNull();
  fireEvent.click(within(row("Notifications")).getByRole("button", { name: "Send" }));
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("cloud.brain.handover", {}));
});

it("shows a login on its way to the brain, or its sign-out, as waiting for it, with a way to send it again", async () => {
  show({ ...none, codex: { ...none.codex, pending: { mode: "apiKey", email: null, plan: null } } });
  expect(await screen.findByText("Waiting for the brain")).toBeTruthy();
  expect(within(row("Codex")).getByText("An OpenAI API key, billed by the token")).toBeTruthy();
  expect(within(row("Codex")).queryByRole("button", { name: "Sign in" })).toBeNull();
  fireEvent.click(within(row("Codex")).getByRole("button", { name: "Send" }));
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("cloud.brain.handover", {}));

  cleanup();
  queryClient.clear();
  show({ ...none, codex: { ...none.codex, mode: "chatgpt", email: "brain@example.com", plan: null, pending: "sign-out" } });
  expect(await screen.findByText("Waiting for the brain")).toBeTruthy();
  expect(within(row("Codex")).getByText("brain@example.com")).toBeTruthy();
  expect(within(row("Codex")).queryByRole("button", { name: "Remove" })).toBeNull();
});

it("says why nothing reached the brain when GitHub is on and this Mac's GitHub CLI is signed out", async () => {
  const blocked = "The GitHub CLI isn't signed in to github.com on this Mac.";
  show({ ...none, github: { on: true, blocked, behind: false } });
  await screen.findByText("Codex");
  expect([github().checked, github().disabled]).toEqual([true, false]);
  expect(within(row("GitHub")).getByText(blocked)).toBeTruthy();
});

it("switches GitHub on and off here, disabled with the reason only on hover while this Mac's GitHub CLI is signed out", async () => {
  show(none);
  await screen.findByText("Codex");
  fireEvent.click(github());
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("cloud.brain.github", { on: true }));

  cleanup();
  queryClient.clear();
  vi.mocked(core.call).mockReset();
  const blocked = "The GitHub CLI isn't signed in to github.com on this Mac.";
  show({ ...none, github: { on: false, blocked, behind: false } });
  await screen.findByText("Codex");
  expect([github().disabled, github().closest("[data-tooltip]")?.getAttribute("data-tooltip")]).toEqual([true, blocked]);
  expect(screen.queryByText(blocked)).toBeNull();
  fireEvent.click(github());
  expect(core.call).not.toHaveBeenCalledWith("cloud.brain.github", expect.anything());
});

it("says once the brain's Codex login is removed that it stays signed in at OpenAI, and where to log it out", async () => {
  window.openorc = { ...window.openorc, openExternal: vi.fn() };
  show({ ...none, codex: { ...none.codex, mode: "chatgpt", email: "brain@example.com", plan: "pro" } });
  await screen.findByText("Codex");
  fireEvent.click(within(row("Codex")).getByRole("button", { name: "Remove" }));
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("cloud.brain.codex.remove", {}));
  const chatgpt = await screen.findByRole("button", { name: "ChatGPT" });
  expect(chatgpt.closest("p")?.textContent).toBe("Removed from OpenOrc. It stays signed in until you log out its session in ChatGPT, under Settings > Security.");
});
