import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import type { HostChoice, HostState, HostSwitch } from "../../../shared/host";
import type { OpenOrcApi } from "../../../shared/types";
import { queryClient } from "../lib/client";
import { HostSettingsSection } from "./settings-host";

function show(state: HostState | undefined, use = vi.fn(async (_host: HostChoice): Promise<HostSwitch> => ({ ok: true }))) {
  window.openorc = { platform: "win32", ...(state ? { host: { get: vi.fn(async () => state), use } } : {}) } as unknown as OpenOrcApi;
  const view = render(
    <QueryClientProvider client={queryClient}>
      <HostSettingsSection />
    </QueryClientProvider>,
  );
  return { use, view };
}
const bridge = window.openorc;
afterEach(() => {
  cleanup();
  queryClient.clear();
  window.openorc = bridge;
});

const settled = () => new Promise((resolve) => setTimeout(resolve, 20));

it("shows nothing where there is no WSL distribution to choose", async () => {
  const { view } = show({ current: { kind: "local" }, distros: [] });
  await settled();
  expect(view.container.textContent).toBe("");
});

it("shows nothing in a window whose bridge has no host controls", async () => {
  const { view } = show(undefined);
  await settled();
  expect(view.container.textContent).toBe("");
});

it("offers this computer and each distribution, with the current one selected", async () => {
  show({
    current: { kind: "wsl", distro: "Ubuntu" },
    distros: [
      { name: "Ubuntu", default: true },
      { name: "Debian", default: false },
    ],
  });
  const select = (await screen.findByRole("combobox", { name: /Run OpenOrc on/ })) as HTMLSelectElement;
  expect([...select.options].map((option) => option.textContent)).toEqual([expect.stringMatching(/^This /), "WSL: Ubuntu", "WSL: Debian"]);
  expect(select.value).toBe("wsl:Ubuntu");
});

it("asks main to run in the chosen distribution", async () => {
  const { use } = show({ current: { kind: "local" }, distros: [{ name: "Ubuntu", default: true }] });
  const select = (await screen.findByRole("combobox", { name: /Run OpenOrc on/ })) as HTMLSelectElement;
  fireEvent.change(select, { target: { value: "wsl:Ubuntu" } });
  await waitFor(() => expect(use).toHaveBeenCalledWith({ kind: "wsl", distro: "Ubuntu" }));
});

it("says why it cannot switch yet, and stays where it was", async () => {
  const refuse = vi.fn(async (): Promise<HostSwitch> => ({ ok: false, reason: "Wait for agent work, approvals, and context maintenance to finish first, then switch." }));
  show({ current: { kind: "local" }, distros: [{ name: "Ubuntu", default: true }] }, refuse);
  const select = (await screen.findByRole("combobox", { name: /Run OpenOrc on/ })) as HTMLSelectElement;
  fireEvent.change(select, { target: { value: "wsl:Ubuntu" } });
  expect((await screen.findByRole("alert")).textContent).toBe("Wait for agent work, approvals, and context maintenance to finish first, then switch.");
  expect(select.value).toBe("local");
});
