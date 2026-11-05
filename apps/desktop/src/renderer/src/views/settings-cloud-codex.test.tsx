import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { CodexCloudAccess } from "@openorc/protocol";
import { afterEach, expect, it, vi } from "vitest";
import { CodexCloudSection } from "./settings-cloud-codex";
import { queryClient } from "../lib/client";
import { core } from "../lib/rpc";

vi.mock("../lib/rpc", () => ({ core: { call: vi.fn(), onReady: vi.fn(), onPush: () => () => {} } }));
afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.resetAllMocks();
});

const none: CodexCloudAccess = { mode: null, email: null, plan: null, refreshedAt: null, signingIn: false, error: null };

function show(codex: CodexCloudAccess) {
  vi.mocked(core.call).mockResolvedValue(null);
  render(
    <QueryClientProvider client={queryClient}>
      <CodexCloudSection codex={codex} />
    </QueryClientProvider>,
  );
}

it("offers a ChatGPT sign-in of its own, or an API key", async () => {
  show(none);
  fireEvent.click(screen.getByRole("button", { name: "Sign in with ChatGPT" }));
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("cloud.codex.signIn", {}));
  fireEvent.click(screen.getByRole("button", { name: "Use an API key" }));
  fireEvent.change(screen.getByPlaceholderText("Paste key"), { target: { value: "sk-test-0123456789" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("cloud.codex.apiKey", { key: "sk-test-0123456789" }));
});

it("waits for the browser sign-in, which can be cancelled", async () => {
  show({ ...none, signingIn: true });
  expect(screen.getByText("Sign in to ChatGPT in the browser that opened.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("cloud.codex.cancel", {}));
});

it("names who Codex signs in as, and signs in again or removes it", async () => {
  show({ ...none, mode: "chatgpt", email: "qa@example.com", plan: "plus" });
  expect(screen.getByText("qa@example.com · ChatGPT Plus")).toBeTruthy();
  expect(screen.getByText("Ready")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Remove" }));
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("cloud.codex.remove", {}));
  cleanup();
  show({ ...none, mode: "apiKey" });
  expect(screen.getByText("An OpenAI API key, billed by the token")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Sign in again" })).toBeNull();
});

it("shows why the sign-in did not finish", () => {
  show({ ...none, error: "The sign-in did not finish. Try again and complete it in the browser." });
  expect(screen.getByRole("alert").textContent).toBe("The sign-in did not finish. Try again and complete it in the browser.");
});

it("says once a login is removed that it still works at OpenAI, and where to end it, until another sign-in begins", async () => {
  window.openorc = { ...window.openorc, openExternal: vi.fn() };
  vi.mocked(core.call).mockResolvedValue(null);
  const section = (codex: CodexCloudAccess) => (
    <QueryClientProvider client={queryClient}>
      <CodexCloudSection codex={codex} />
    </QueryClientProvider>
  );
  const view = render(section({ ...none, mode: "chatgpt", email: "qa@example.com", plan: "plus" }));
  expect(screen.queryByText(/until you/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Remove" }));
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("cloud.codex.remove", {}));
  view.rerender(section(none));
  const chatgpt = await screen.findByRole("button", { name: "ChatGPT" });
  expect(chatgpt.closest("p")?.textContent).toBe("Removed from OpenOrc. It stays signed in until you log out its session in ChatGPT, under Settings > Security.");
  fireEvent.click(chatgpt);
  expect(window.openorc.openExternal).toHaveBeenCalledWith("https://chatgpt.com");
  fireEvent.click(screen.getByRole("button", { name: "Use an API key" }));
  expect(screen.queryByText(/until you/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Use an API key" }));

  view.rerender(section({ ...none, mode: "apiKey" }));
  fireEvent.click(screen.getByRole("button", { name: "Remove" }));
  await waitFor(() => expect(vi.mocked(core.call).mock.calls.filter(([method]) => method === "cloud.codex.remove")).toHaveLength(2));
  view.rerender(section(none));
  const account = await screen.findByRole("button", { name: "your OpenAI account" });
  expect(account.closest("p")?.textContent).toBe("Removed from OpenOrc. It still works until you delete it in your OpenAI account.");
  fireEvent.click(account);
  expect(window.openorc.openExternal).toHaveBeenCalledWith("https://platform.openai.com/api-keys");
});
