import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CloudCheck, CloudStatus } from "@openorc/protocol";
import { afterEach, expect, it, vi } from "vitest";
import { CloudCheckSection } from "./settings-cloud-check";
import { core } from "../lib/rpc";

vi.mock("../lib/rpc", () => ({ core: { call: vi.fn(), onReady: vi.fn(), onPush: () => () => {} } }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const steps = (states: CloudCheck["steps"][number]["state"][]): CloudCheck["steps"] =>
  (["sandbox", "tools", "runner", "relay", "sync", "remove"] as const).map((step, index) => ({ step, state: states[index] ?? "pending", ms: null, detail: null, error: null }));

function show(check: CloudCheck | null, vercel: CloudStatus["vercel"] = null) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <CloudCheckSection status={{ vercel, claude: {}, codex: { mode: null, email: null, plan: null, refreshedAt: null, signingIn: false, error: null }, check, error: null, takeover: false }} />
    </QueryClientProvider>,
  );
}

it("starts a check where new cloud threads run", async () => {
  vi.mocked(core.call).mockResolvedValue(null);
  show(null, { team: { id: "t", name: "Team" }, project: "openorc-sandboxes", vcpus: null, region: "sin1" });
  expect(screen.getByText("On Vercel")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Run check" }));
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("cloud.check", {}));
});

it("shows the steps while it runs, without a second start", () => {
  show({ provider: "local", passed: null, steps: steps(["done", "running"]) });
  expect(screen.getByText("In a sandbox simulated on this Mac")).toBeTruthy();
  expect((screen.getByRole("button", { name: "Checking" }) as HTMLButtonElement).disabled).toBe(true);
  const rows = within(screen.getByRole("list", { name: "Cloud check" })).getAllByRole("listitem");
  expect(rows.map((row) => row.dataset.state)).toEqual(["done", "running", "pending", "pending", "pending", "pending"]);
});

it("names the step that failed, with what went wrong, and what it found before", () => {
  const failed = steps(["done", "done", "failed", "pending", "pending", "done"]);
  failed[1] = { ...failed[1]!, detail: "Node 24.1.0 · Git 2.43.0 · Claude Code 2.1.316", ms: 1200 };
  failed[2] = { ...failed[2]!, error: 'The runner\'s process answered "" (exit 1).', ms: 300 };
  show({ provider: "vercel", passed: false, steps: failed });
  expect(screen.getByText("A cloud thread would fail at the step marked below.")).toBeTruthy();
  expect(screen.getByRole("alert").textContent).toBe('The runner\'s process answered "" (exit 1).');
  expect(screen.getByText("Node 24.1.0 · Git 2.43.0 · Claude Code 2.1.316")).toBeTruthy();
  expect(screen.getByText("1.2 s")).toBeTruthy();
  expect((screen.getByRole("button", { name: "Run check" }) as HTMLButtonElement).disabled).toBe(false);
});
