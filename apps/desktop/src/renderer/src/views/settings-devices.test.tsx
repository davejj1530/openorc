import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DeviceStatus, RpcMethod, RpcParams, RpcResults } from "@openorc/protocol";
import { queryClient } from "../lib/client";
import { core } from "../lib/rpc";
import { DeviceSettings } from "./settings-devices";

let status: DeviceStatus;
let saved: unknown[];

beforeEach(() => {
  saved = [];
  status = {
    settings: { enabled: true, agentAccess: true },
    helpers: { phase: "running" },
    platforms: [{ platform: "ios", available: true, reason: null }],
    tools: [
      { name: "expo-device-hub", pinned: "0.18.0", installed: "0.18.0" },
      { name: "agent-device", pinned: "0.21.31", installed: null },
    ],
    blocked: null,
  };
  queryClient.setDefaultOptions({ queries: { retry: false, staleTime: Infinity } });
  vi.spyOn(core, "call").mockImplementation(async <M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<RpcResults[M]> => {
    if (method === "devices.settings.set") {
      saved.push(params);
      status = { ...status, settings: { ...status.settings, ...(params as Partial<DeviceStatus["settings"]>) } };
    }
    return status as RpcResults[M];
  });
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.restoreAllMocks();
});

const mount = () =>
  render(
    <QueryClientProvider client={queryClient}>
      <DeviceSettings active />
    </QueryClientProvider>,
  );

it("saves agent access and device support through the core, and lists the installed tools on demand", async () => {
  mount();
  const access = (await screen.findByRole("switch", { name: /Agents can use devices/ })) as HTMLInputElement;
  expect(access.checked).toBe(true);
  fireEvent.click(access);
  await waitFor(() => expect(saved).toEqual([{ agentAccess: false }]));
  await waitFor(() => expect((screen.getByRole("switch", { name: /Agents can use devices/ }) as HTMLInputElement).checked).toBe(false));
  fireEvent.click(screen.getByRole("switch", { name: /Device support/ }));
  await waitFor(() => expect(saved).toEqual([{ agentAccess: false }, { enabled: false }]));
  expect(screen.getByText("Installed tools").closest("details")?.open).toBe(false);
  expect(screen.getByText("expo-device-hub 0.18.0")).toBeTruthy();
  expect(screen.getByText("agent-device not installed")).toBeTruthy();
});

it("keeps device support off with the reason when this Mac cannot run the tools", async () => {
  status = { ...status, settings: { enabled: false, agentAccess: true }, blocked: "Device support needs Node.js 22.12 or later." };
  mount();
  expect(await screen.findByText("Device support needs Node.js 22.12 or later.")).toBeTruthy();
  expect((screen.getByRole("switch", { name: /Device support/ }) as HTMLInputElement).disabled).toBe(true);
});
