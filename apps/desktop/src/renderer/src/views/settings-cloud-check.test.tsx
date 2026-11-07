import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CloudCheck, CloudProvider } from "@openorc/protocol";
import { afterEach, expect, it, vi } from "vitest";
import { CloudCheckCard } from "./settings-cloud-check";
import { core } from "../lib/rpc";

vi.mock("../lib/rpc", () => ({ core: { call: vi.fn(), onReady: vi.fn(), onPush: () => () => {} } }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const steps = (states: CloudCheck["steps"][number]["state"][]): CloudCheck["steps"] =>
  (["sandbox", "tools", "runner", "relay", "signins", "sync", "remove"] as const).map((step, index) => ({ step, state: states[index] ?? "pending", ms: null, detail: null, error: null }));

function show(check: CloudCheck | null, place: CloudProvider | null) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <CloudCheckCard check={check} place={place} />
    </QueryClientProvider>,
  );
}

it("starts a check where new cloud threads run", async () => {
  vi.mocked(core.call).mockResolvedValue(null);
  show(null, "vercel");
  expect(screen.getByText("On Vercel")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Run check" }));
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("cloud.check", {}));
});

it("hides a check that ran on another service, so Agent37 is never judged by Vercel's result", () => {
  const failed = steps(["failed", "pending", "pending", "pending", "pending", "pending", "failed"]);
  failed[0] = { ...failed[0]!, error: "Connect Vercel in Settings to run in the cloud." };
  show({ provider: "vercel", passed: false, steps: failed }, "agent37");
  expect(screen.getByText("On Agent37")).toBeTruthy();
  expect(screen.queryByRole("list", { name: "Cloud check" })).toBeNull();
  expect(screen.queryByText(/Connect Vercel/)).toBeNull();
  expect((screen.getByRole("button", { name: "Run check" }) as HTMLButtonElement).disabled).toBe(false);
});

it("cannot run while new cloud threads have nowhere to run", () => {
  show(null, null);
  expect((screen.getByRole("button", { name: "Run check" }) as HTMLButtonElement).disabled).toBe(true);
});

it("shows the steps while it runs, without a second start", () => {
  show({ provider: "local", passed: null, steps: steps(["done", "running"]) }, "local");
  expect(screen.getByText("In a sandbox simulated on this Mac")).toBeTruthy();
  expect((screen.getByRole("button", { name: "Checking" }) as HTMLButtonElement).disabled).toBe(true);
  const rows = within(screen.getByRole("list", { name: "Cloud check" })).getAllByRole("listitem");
  expect(rows.map((row) => row.dataset.state)).toEqual(["done", "running", "pending", "pending", "pending", "pending", "pending"]);
});

it("names the step that failed, with what went wrong, and what it found before", () => {
  const failed = steps(["done", "done", "failed", "pending", "pending", "pending", "done"]);
  failed[1] = { ...failed[1]!, detail: "Node 24.1.0 · Git 2.43.0 · Claude Code 2.1.316", ms: 1200 };
  failed[2] = { ...failed[2]!, error: 'The runner\'s process answered "" (exit 1).', ms: 300 };
  show({ provider: "vercel", passed: false, steps: failed }, "vercel");
  expect(screen.getByRole("alert").textContent).toBe('The runner\'s process answered "" (exit 1).');
  expect(screen.getByText("Node 24.1.0 · Git 2.43.0 · Claude Code 2.1.316")).toBeTruthy();
  expect(screen.getByText("1.2 s")).toBeTruthy();
  expect((screen.getByRole("button", { name: "Run again" }) as HTMLButtonElement).disabled).toBe(false);
});

it("marks a step that does not apply on the service with an empty ring and its reason, not a check", () => {
  const ran = steps(["done", "done", "done", "done", "skipped", "done", "done"]);
  ran[4] = { ...ran[4]!, detail: "This service keeps each agent's sign-in in its sandbox." };
  show({ provider: "agent37", passed: true, steps: ran }, "agent37");
  const row = within(screen.getByRole("list", { name: "Cloud check" }))
    .getByText("Keep sign-ins outside the sandbox")
    .closest("li")!;
  expect(row.dataset.state).toBe("skipped");
  expect(row.querySelector(".step-mark")?.getAttribute("data-state")).toBe("pending");
  expect(within(row).getByText("This service keeps each agent's sign-in in its sandbox.")).toBeTruthy();
});
