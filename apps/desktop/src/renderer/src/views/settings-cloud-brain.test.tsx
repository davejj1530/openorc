import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { CloudBrainStatus } from "@openorc/protocol";
import { afterEach, expect, it, vi } from "vitest";
import { CloudBrainSection } from "./settings-cloud-brain";
import { queryClient } from "../lib/client";
import { core } from "../lib/rpc";

vi.mock("../lib/rpc", () => ({ core: { call: vi.fn(), onReady: vi.fn(), onPush: () => () => {} } }));
afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

const ready: Extract<CloudBrainStatus, { state: "ready" }> = {
  state: "ready",
  region: "sin1",
  machine: "asleep",
  claude: ["Personal", "Work"],
  behind: false,
  working: null,
  error: null,
};

function show(status: CloudBrainStatus, timeZone = "Asia/Manila") {
  vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue({ timeZone } as Intl.ResolvedDateTimeFormatOptions);
  vi.mocked(core.call).mockImplementation(async (method: string) => {
    if (method === "cloud.brain.pair") return { url: "openorc://pair#v1.brain-fixture", expiresAt: Date.now() + 120_000 } as never;
    if (method === "cloud.brain.projects") return [] as never;
    return status as never;
  });
  render(
    <QueryClientProvider client={queryClient}>
      <CloudBrainSection active />
    </QueryClientProvider>,
  );
}

const region = () => screen.getByRole("combobox", { name: "Region" }) as HTMLSelectElement;

it("sets up in the region nearest the Mac's time zone, or the one chosen", async () => {
  show({ state: "none", error: null }, "Europe/Berlin");
  await screen.findByRole("button", { name: "Set up" });
  expect(region().value).toBe("fra1");
  fireEvent.change(region(), { target: { value: "sin1" } });
  fireEvent.click(screen.getByRole("button", { name: "Set up" }));
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("cloud.brain.create", { region: "sin1" }));
  for (const [zone, nearest] of [
    ["America/Los_Angeles", "sfo1"],
    ["America/Chicago", "iad1"],
    ["Asia/Tokyo", "hnd1"],
    ["Asia/Manila", "sin1"],
    ["Australia/Sydney", "syd1"],
    ["America/Argentina/Buenos_Aires", "gru1"],
    ["Asia/Shanghai", "hkg1"],
  ]) {
    cleanup();
    queryClient.clear();
    show({ state: "none", error: null }, zone);
    await screen.findByRole("button", { name: "Set up" });
    expect([zone, region().value]).toEqual([zone, nearest]);
  }
});

it("cannot be set up in a build without the brain", async () => {
  show({ state: "unavailable" });
  expect(((await screen.findByRole("button", { name: "Set up" })) as HTMLButtonElement).disabled).toBe(true);
  expect(region().disabled).toBe(true);
});

it("shows how far setting up has come", async () => {
  show({ state: "setting-up", region: "sin1", step: "start" });
  const steps = within(await screen.findByRole("list", { name: "Setting up the cloud brain" })).getAllByRole("listitem");
  expect(steps.map((step) => [step.textContent, step.getAttribute("data-state")])).toEqual([
    ["Make its machine and install it", "done"],
    ["Start it", "running"],
    ["Send it the Claude sign-ins", "pending"],
  ]);
  expect(screen.getByText("Singapore · sin1")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
});

it("shows a set-up brain asleep with the Claude accounts it was sent, and wakes it", async () => {
  show(ready);
  expect(await screen.findByText("Asleep")).toBeTruthy();
  expect(screen.getByText("Personal, Work")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Wake" }));
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("cloud.brain.wake", {}));
});

it("pairs a phone with the brain's own code", async () => {
  show({ ...ready, machine: "awake" });
  fireEvent.click(await screen.findByRole("button", { name: "Pair phone" }));
  const sheet = await screen.findByRole("dialog", { name: "Pair a phone" });
  await within(sheet).findByRole("img", { name: "Pairing code" });
  expect(core.call).toHaveBeenCalledWith("cloud.brain.pair", {});
  expect(within(sheet).getByText(/Expires in 1:5\d|Expires in 2:00/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Wake" })).toBeNull();
});

it("removes the brain only once the removal is confirmed", async () => {
  show(ready);
  fireEvent.click(await screen.findByRole("button", { name: "Remove" }));
  const confirm = await screen.findByRole("dialog", { name: "Remove the cloud brain?" });
  fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
  expect(core.call).not.toHaveBeenCalledWith("cloud.brain.remove", {});
  fireEvent.click(screen.getByRole("button", { name: "Remove" }));
  fireEvent.click(within(await screen.findByRole("dialog", { name: "Remove the cloud brain?" })).getByRole("button", { name: "Remove" }));
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("cloud.brain.remove", {}));
});

it("sends the Claude sign-ins again after they failed to arrive, and says why", async () => {
  show({ ...ready, behind: true, error: "The cloud brain did not start. Exited 1." });
  expect((await screen.findByRole("alert")).textContent).toBe("The cloud brain did not start. Exited 1.");
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("cloud.brain.handover", {}));
});

it("hides waking and sending while the brain is at either", async () => {
  show({ ...ready, working: "sending", behind: true });
  expect(await screen.findByText("Sending")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Wake" })).toBeNull();
  expect((screen.getByRole("button", { name: "Pair phone" }) as HTMLButtonElement).disabled).toBe(true);
});

it("says it is updating, quietly, with nothing to click meanwhile", async () => {
  show({ ...ready, machine: "awake", working: "updating", behind: true });
  expect((await screen.findByText("Updating")).getAttribute("data-ok")).toBeNull();
  expect(screen.queryByText("Awake")).toBeNull();
  expect(screen.queryByRole("button", { name: "Wake" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
  expect((screen.getByRole("button", { name: "Pair phone" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.queryByRole("alert")).toBeNull();
});

it("offers to remove a brain this Mac has no key for", async () => {
  show({ state: "elsewhere", error: null });
  expect(await screen.findByText("Already in this team")).toBeTruthy();
  expect(screen.getByText("This Mac doesn't have its key.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Set up" })).toBeNull();
  expect(screen.getByRole("button", { name: "Remove" })).toBeTruthy();
});

it("sets up again in the region it was made in after setup stopped", async () => {
  show({ state: "incomplete", region: "fra1", error: "The cloud brain needs setting up again. No brain is installed on its sandbox." });
  expect((await screen.findByRole("alert")).textContent).toContain("needs setting up again");
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("cloud.brain.create", { region: "fra1" }));
});
