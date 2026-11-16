import type { CloudMachine, CloudMachines } from "@openorc/protocol";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { queryClient } from "../lib/client";
import { core } from "../lib/rpc";
import { CloudMachinesSection } from "./settings-cloud-machines";

vi.mock("../lib/rpc", () => ({ core: { call: vi.fn(), onReady: vi.fn(), onPush: () => () => {} } }));

const now = Date.now();
const machine = (id: string, more: Partial<CloudMachine> = {}): CloudMachine => ({
  id,
  serviceName: "Vercel",
  since: now - 14 * 60_000,
  seconds: 840,
  threads: [{ id: `t-${id}`, title: "Fix the login redirect", holds: ["resting"] }],
  stop: { can: true },
  ...more,
});
let machines: CloudMachines;
const hours = { leftSeconds: 87 * 3600, monthly: { grantedSeconds: 100 * 3600, leftSeconds: 87 * 3600, resetsAt: now }, packsLeftSeconds: 0 };

beforeEach(() => {
  machines = { state: "ready", machines: [] };
  vi.mocked(core.call).mockImplementation((async (method: string, params: { id: string }) => {
    if (method === "account.status") return { state: "signed-in", hours };
    if (method === "cloudMachines.read") return machines;
    if (method === "cloudMachines.stop") {
      if (machines.state === "ready") machines = { state: "ready", machines: machines.machines.filter((one) => one.id !== params.id) };
      return machines;
    }
    return null;
  }) as never);
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.resetAllMocks();
});

const show = () => render(<QueryClientProvider client={queryClient}>{<CloudMachinesSection active />}</QueryClientProvider>);

it("is absent where the server lists no machines", async () => {
  machines = { state: "unavailable" };
  show();
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("cloudMachines.read", {}));
  expect(screen.queryByText("Machines")).toBeNull();
});

it("says nothing is running, and this month's hours", async () => {
  show();
  expect(await screen.findByText("Nothing is running.")).toBeTruthy();
  expect(await screen.findByText("13 h of 100 h")).toBeTruthy();
});

it("names each machine by its thread or its service, says what it used this time, holds a Stop with why, and stops one", async () => {
  machines = {
    state: "ready",
    machines: [
      machine("m1"),
      machine("m2", {
        serviceName: "Agent37",
        seconds: 3960,
        threads: [
          { id: "a", title: "Port the parser", holds: ["turn"] },
          { id: "b", title: "Tidy the docs", holds: ["resting"] },
        ],
        stop: { can: false, reason: "Someone else's work is running there." },
      }),
    ],
  };
  show();
  expect(await screen.findByText("Fix the login redirect")).toBeTruthy();
  expect(screen.getByText("Awake for 14 min · On Vercel")).toBeTruthy();
  expect(screen.getByText("0.2 h used")).toBeTruthy();
  expect(screen.getByText("Your machine on Agent37")).toBeTruthy();
  expect(screen.getByText("Awake for 14 min · On Agent37 · 2 threads")).toBeTruthy();
  expect(screen.getByText("1.1 h used")).toBeTruthy();
  const [first, held] = screen.getAllByRole("button", { name: "Stop" }) as HTMLButtonElement[];
  expect(held!.disabled).toBe(true);
  expect(held!.getAttribute("data-tip")).toBe("Someone else's work is running there.");
  fireEvent.click(first!);
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("cloudMachines.stop", { id: "m1" }));
  await waitFor(() => expect(screen.queryByText("Fix the login redirect")).toBeNull());
});
