import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { CloudStatus } from "@openorc/protocol";
import { afterEach, expect, it, vi } from "vitest";
import { CloudSettings } from "./settings-cloud";
import { queryClient } from "../lib/client";
import { core } from "../lib/rpc";

vi.mock("../lib/rpc", () => ({ core: { call: vi.fn(), onReady: vi.fn(), onPush: () => () => {} } }));
afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.resetAllMocks();
});

const base: CloudStatus = {
  vercel: null,
  agent37: null,
  service: null,
  claude: {},
  codex: { mode: null, email: null, plan: null, refreshedAt: null, signingIn: false, error: null },
  opencode: { providers: [] },
  check: null,
  takeover: false,
  error: null,
};

function show(cloud: CloudStatus) {
  vi.mocked(core.call).mockImplementation(async (method: string) => {
    const answers: Record<string, unknown> = { "cloud.status": cloud, "claude.accounts.list": { accounts: [] }, "cloud.sandboxes": [], "cloud.vercel.teams": [] };
    return (method.startsWith("cloud.agent37.") || method === "cloud.service" ? cloud : answers[method]) as never;
  });
  render(
    <QueryClientProvider client={queryClient}>
      <CloudSettings active />
    </QueryClientProvider>,
  );
}

it("connects Agent37 with a pasted key, which the field forgets", async () => {
  show(base);
  const key = (await screen.findByPlaceholderText("Paste key")) as HTMLInputElement;
  fireEvent.change(key, { target: { value: " sk_live_abc " } });
  fireEvent.click(screen.getAllByRole("button", { name: "Connect" }).at(-1)!);
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("cloud.agent37.connect", { key: "sk_live_abc" }));
  expect(key.value).toBe("");
});

it("sizes new instances once connected, and offers no service choice with Agent37 alone", async () => {
  show({ ...base, agent37: { size: { cpu: 2, memory: 4 } }, service: "agent37" });
  fireEvent.click(await screen.findByRole("button", { name: /^Connect a cloud service/ }));
  const size = screen.getByRole("combobox", { name: /^Instance size/ }) as HTMLSelectElement;
  expect(size.selectedOptions[0]?.textContent).toBe("2 vCPUs · 4 GB");
  fireEvent.change(size, { target: { value: "2" } });
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("cloud.agent37.size", { size: { cpu: 4, memory: 16 } }));
  expect(screen.queryByRole("combobox", { name: /^Run on/ })).toBeNull();
});

it("chooses the service new cloud threads run on while both are connected", async () => {
  show({ ...base, vercel: { team: { id: "team_a", name: "Acme" }, project: "openorc-sandboxes", vcpus: null, region: "iad1" }, agent37: { size: { cpu: 2, memory: 4 } }, service: "vercel" });
  fireEvent.click(await screen.findByRole("button", { name: /^Connect a cloud service/ }));
  const choice = screen.getByRole("combobox", { name: /^Run on/ }) as HTMLSelectElement;
  expect(choice.value).toBe("vercel");
  fireEvent.change(choice, { target: { value: "agent37" } });
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("cloud.service", { service: "agent37" }));
});
