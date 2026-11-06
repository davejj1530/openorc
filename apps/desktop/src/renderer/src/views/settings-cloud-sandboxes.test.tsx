import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { CloudSandbox } from "@openorc/protocol";
import { afterEach, expect, it, vi } from "vitest";
import { CloudSandboxesSection } from "./settings-cloud-sandboxes";
import { queryClient } from "../lib/client";
import { core } from "../lib/rpc";

vi.mock("../lib/rpc", () => ({ core: { call: vi.fn(), onReady: vi.fn(), onPush: () => () => {} } }));
afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.resetAllMocks();
});

const now = Date.now();
const sandboxes: CloudSandbox[] = [
  {
    name: "openorc-a",
    provider: "vercel",
    thread: { id: "a", title: "Add a footer" },
    state: "running",
    awakeSince: now - 12 * 60_000,
    awakeMs: 3_600_000,
    vcpus: 8,
    memoryMb: 16_384,
    costUsd: 0.352,
    working: true,
    createdAt: now - 7_200_000,
  },
  {
    name: "openorc-b",
    provider: "vercel",
    thread: { id: "b", title: "Rename the package" },
    state: "stopped",
    awakeSince: null,
    awakeMs: 65 * 60_000,
    vcpus: 2,
    memoryMb: 4096,
    costUsd: 0.004,
    working: false,
    createdAt: now - 60_000,
  },
  { name: "openorc-check-1a2b", provider: "vercel", thread: null, state: "stopped", awakeSince: null, awakeMs: 0, vcpus: 2, memoryMb: 4096, costUsd: 0, working: false, createdAt: now - 1000 },
];

function show() {
  vi.mocked(core.call).mockImplementation(async (method: string) => (method === "cloud.sandboxes" || method === "cloud.sandboxes.remove" ? sandboxes : null) as never);
  render(
    <QueryClientProvider client={queryClient}>
      <CloudSandboxesSection active />
    </QueryClientProvider>,
  );
}

it("lists each sandbox with its conversation, whether it is awake, its size and its cost, and the total", async () => {
  show();
  await screen.findByText("Add a footer");
  expect(screen.getByText("Awake for 12 min · 8 vCPUs · 16 GB · On Vercel")).toBeTruthy();
  expect(screen.getByText("Asleep, awake 1 h 5 min in all · 2 vCPUs · 4 GB · On Vercel")).toBeTruthy();
  expect(screen.getByText("openorc-check-1a2b")).toBeTruthy();
  expect(screen.getByText("Asleep · 2 vCPUs · 4 GB · On Vercel · No conversation")).toBeTruthy();
  expect(screen.getByText("$0.35")).toBeTruthy();
  expect(screen.getByText("under $0.01")).toBeTruthy();
  expect(screen.getByText("Vercel about $0.36 at list prices")).toBeTruthy();
});

it("removes a sandbox, but not one whose agent is at work", async () => {
  show();
  await screen.findByText("Add a footer");
  const removes = screen.getAllByRole("button", { name: "Remove" }) as HTMLButtonElement[];
  expect(removes.map((button) => button.disabled)).toEqual([true, false, false]);
  fireEvent.click(removes[1]!);
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("cloud.sandboxes.remove", { name: "openorc-b" }));
});

it("names each sandbox's service and totals each service apart, never calling Agent37's spend Vercel's prices", async () => {
  const mixed: CloudSandbox[] = [
    sandboxes[1]!,
    { ...sandboxes[1]!, name: "openorc-c", provider: "agent37", thread: { id: "c", title: "Fix the build" }, costUsd: 0.12 },
    { ...sandboxes[1]!, name: "openorc-d", provider: "local", thread: { id: "d", title: "Greeting" }, vcpus: null, costUsd: null },
  ];
  vi.mocked(core.call).mockImplementation(async (method: string) => (method === "cloud.sandboxes" ? mixed : null) as never);
  render(
    <QueryClientProvider client={queryClient}>
      <CloudSandboxesSection active />
    </QueryClientProvider>,
  );
  await screen.findByText("Fix the build");
  expect(screen.getByText("Asleep, awake 1 h 5 min in all · 2 vCPUs · 4 GB · On Agent37")).toBeTruthy();
  expect(screen.getByText("Asleep, awake 1 h 5 min in all · Simulated on this Mac")).toBeTruthy();
  expect(screen.getByText("Vercel under $0.01 at list prices · Agent37 $0.12")).toBeTruthy();
  expect(screen.queryByText(/Vercel's list prices/)).toBeNull();
});
