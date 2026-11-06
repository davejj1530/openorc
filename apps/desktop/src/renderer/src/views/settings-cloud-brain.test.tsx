import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { CloudBrainCost, CloudBrainStatus, CloudService, CloudSignIns, RemoteDevice } from "@openorc/protocol";
import { afterEach, expect, it, vi } from "vitest";
import { CloudBrain } from "./settings-cloud-brain";
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
  service: "vercel",
  region: "sin1",
  machine: "asleep",
  claude: ["Personal", "Work"],
  behind: false,
  working: null,
  door: null,
  threads: 0,
  error: null,
};

function show(
  status: CloudBrainStatus,
  timeZone = "Asia/Manila",
  cost: CloudBrainCost | null = null,
  phones: RemoteDevice[] = [],
  codex: "chatgpt" | "apiKey" | null = null,
  service: CloudService = "vercel",
  signIns: CloudSignIns = { rows: [], bringing: false },
  services: CloudService[] = [service],
) {
  vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue({ timeZone } as Intl.ResolvedDateTimeFormatOptions);
  vi.mocked(core.call).mockImplementation(async (method: string) => {
    if (method === "cloud.brain.pair") return { url: "openorc://pair#v1.brain-fixture", expiresAt: Date.now() + 120_000 } as never;
    if (method === "cloud.brain.projects") return [] as never;
    if (method === "cloud.brain.cost") return cost as never;
    if (method === "cloud.signIns") return signIns as never;
    if (method === "cloud.brain.phones" || method === "cloud.brain.phones.remove") return phones as never;
    if (method === "cloud.brain.signIns")
      return {
        codex: { mode: codex, email: null, plan: null, signingIn: false, pending: null, error: null },
        github: { on: false, blocked: null, behind: false },
        push: { has: false, behind: false },
        memory: { has: false, behind: false },
      } as never;
    return status as never;
  });
  render(
    <QueryClientProvider client={queryClient}>
      <CloudBrain active service={service} services={services} />
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
  show({ state: "setting-up", service: "vercel", region: "sin1", step: "start" });
  const steps = within(await screen.findByRole("list", { name: "Setting up the cloud brain" })).getAllByRole("listitem");
  expect(steps.map((step) => [step.textContent, step.getAttribute("data-state")])).toEqual([
    ["Make its machine and install it", "done"],
    ["Start it", "running"],
    ["Send it the sign-ins", "pending"],
  ]);
  expect(screen.getByText("Vercel · Singapore")).toBeTruthy();
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

it("says quietly what the brain and its thread sandboxes cost this month, once Vercel said", async () => {
  show(ready, "Asia/Manila", { usd: 3.456, since: 1 });
  expect(await screen.findByText("$3.46 this month")).toBeTruthy();
  cleanup();
  queryClient.clear();
  show(ready);
  expect(await screen.findByText("Asleep")).toBeTruthy();
  expect(screen.queryByText(/this month/)).toBeNull();
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

it("lists the phones paired with the brain as the Phone page does, and unpairs one there", async () => {
  const pocket = { id: "phone-1", name: "Pocket", createdAt: Date.now() - 86_400_000, lastSeenAt: Date.now() - 7_200_000, connected: false };
  show({ ...ready, machine: "awake" }, "Asia/Manila", null, [pocket, { ...pocket, id: "phone-2", name: "Tablet", lastSeenAt: null }]);
  const row = (await screen.findByText("Pocket")).closest(".settings-field") as HTMLElement;
  expect(within(row).getByText("Last seen 2h ago")).toBeTruthy();
  expect(within(screen.getByText("Tablet").closest(".settings-field") as HTMLElement).getByText("Paired 1d ago")).toBeTruthy();
  fireEvent.click(within(row).getByRole("button", { name: "Remove Pocket" }));
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("cloud.brain.phones.remove", { id: "phone-1" }));
  expect(core.call).not.toHaveBeenCalledWith("remote.devices.remove", expect.anything());

  cleanup();
  queryClient.clear();
  show({ ...ready, machine: "awake", working: "waking" }, "Asia/Manila", null, [pocket]);
  expect(((await screen.findByRole("button", { name: "Remove Pocket" })) as HTMLButtonElement).disabled).toBe(true);
});

it("says in the removal confirm that the brain's own Codex login stays signed in at OpenAI, and where to end it", async () => {
  show({ ...ready, machine: "awake" }, "Asia/Manila", null, [], "chatgpt");
  fireEvent.click(await screen.findByRole("button", { name: "Remove" }));
  const chatgpt = await screen.findByRole("button", { name: "ChatGPT" });
  expect(chatgpt.closest("p")?.textContent).toBe("Its Codex login stays signed in until you log out its session in ChatGPT, under Settings > Security.");
  cleanup();
  queryClient.clear();
  show({ ...ready, machine: "awake" }, "Asia/Manila", null, [], "apiKey");
  fireEvent.click(await screen.findByRole("button", { name: "Remove" }));
  const account = await screen.findByRole("button", { name: "your OpenAI account" });
  expect(account.closest("p")?.textContent).toBe("Its OpenAI API key still works until you delete it in your OpenAI account.");
  cleanup();
  queryClient.clear();
  show({ ...ready, machine: "awake" });
  fireEvent.click(await screen.findByRole("button", { name: "Remove" }));
  await screen.findByText("Remove the cloud brain?");
  expect(screen.queryByText(/until you/)).toBeNull();
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

it("says how many conversations go with the brain, counted again as the confirm opens", async () => {
  show({ ...ready, threads: 3 });
  fireEvent.click(await screen.findByRole("button", { name: "Remove" }));
  const confirm = await screen.findByRole("dialog", { name: "Remove the cloud brain?" });
  expect(confirm.textContent).toContain("with its disk, the sandboxes it made and the 3 conversations on it. Bring to Mac any you want to keep first.");
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("cloud.brain.recount", {}));
  cleanup();
  queryClient.clear();
  show({ ...ready, threads: 1 });
  fireEvent.click(await screen.findByRole("button", { name: "Remove" }));
  expect((await screen.findByRole("dialog", { name: "Remove the cloud brain?" })).textContent).toContain(
    "with its disk, the sandboxes it made and the conversation on it. Bring it to your Mac first to keep it. Phones paired",
  );
  cleanup();
  queryClient.clear();
  show(ready);
  fireEvent.click(await screen.findByRole("button", { name: "Remove" }));
  expect((await screen.findByRole("dialog", { name: "Remove the cloud brain?" })).textContent).not.toContain("conversation");
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

it("shows the door's state in a word, with nothing to click, and why it did not open", async () => {
  show({ ...ready, door: { state: "open" } });
  const door = (await screen.findByText("Door")).closest(".settings-field") as HTMLElement;
  expect(within(door).getByText("Open").getAttribute("data-ok")).toBe("true");
  expect(within(door).queryAllByRole("button")).toEqual([]);
  cleanup();
  queryClient.clear();
  show({ ...ready, door: { state: "opening" } });
  expect((await screen.findByText("Opening")).getAttribute("data-ok")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  cleanup();
  queryClient.clear();
  show({ ...ready, door: { state: "failed", error: "Could not deploy the door: Vercel is having a moment." } });
  expect(await screen.findByText("Not open")).toBeTruthy();
  expect((await screen.findByRole("alert")).textContent).toBe("Could not deploy the door: Vercel is having a moment.");
});

it("shows no door before this Mac has looked at it", async () => {
  show(ready);
  await screen.findByText("Asleep");
  expect(screen.queryByText("Door")).toBeNull();
});

it("offers to remove a brain this Mac has no key for", async () => {
  show({ state: "elsewhere", service: "vercel", error: null });
  expect(await screen.findByText("Already in this team")).toBeTruthy();
  expect(screen.getByText("This Mac doesn't have its key.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Set up" })).toBeNull();
  expect(screen.getByRole("button", { name: "Remove" })).toBeTruthy();
});

it("sets up again in the region it was made in after setup stopped", async () => {
  show({ state: "incomplete", service: "vercel", region: "fra1", error: "The cloud brain needs setting up again. No brain is installed on its sandbox." });
  expect((await screen.findByRole("alert")).textContent).toContain("needs setting up again");
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("cloud.brain.create", { region: "fra1" }));
});

it("sets up on Agent37 without a region, and names its cost and removal for Agent37", async () => {
  show({ state: "none", error: null }, "Asia/Manila", null, [], null, "agent37");
  fireEvent.click(await screen.findByRole("button", { name: "Set up" }));
  expect(screen.queryByRole("combobox", { name: "Region" })).toBeNull();
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("cloud.brain.create", {}));
  cleanup();
  queryClient.clear();
  show({ ...ready, service: "agent37", region: null, threads: 2 }, "Asia/Manila", { usd: 0.42, since: 1 }, [], null, "vercel");
  expect(await screen.findByText("Agent37")).toBeTruthy();
  expect(await screen.findByText("$0.42 this month")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Remove" }));
  expect((await screen.findByRole("dialog", { name: "Remove the cloud brain?" })).textContent).toContain(
    "This deletes it from your Agent37 account, with its disk, the instances it made and the 2 conversations on it.",
  );
});

it("tries setting up an Agent37 brain again without a region", async () => {
  show({ state: "incomplete", service: "agent37", region: null, error: "The cloud brain did not start." });
  fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("cloud.brain.create", {}));
  expect(screen.getByText("Agent37")).toBeTruthy();
});

it("offers to bring the missing sign-ins before the brain's first wake", async () => {
  const signIns: CloudSignIns = { rows: [{ kind: "claude", accountId: "work", label: "Work", state: "missing", way: "private-window", error: null }], bringing: false };
  show({ state: "none", error: null }, "Asia/Manila", null, [], null, "vercel", signIns);
  fireEvent.click(await screen.findByRole("button", { name: "Bring them" }));
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("cloud.signIns.bringAll", { copy: false }));
  expect(screen.getByRole("button", { name: "Set up" })).toBeTruthy();
});

it("asks where it runs once both services are connected, starting on the one new threads run on", async () => {
  show({ state: "none", error: null }, "Europe/Berlin", null, [], null, "vercel", undefined, ["vercel", "agent37"]);
  const choice = await screen.findByRole("radiogroup", { name: "Runs on" });
  expect(within(choice).getByRole("radio", { name: "Vercel" }).getAttribute("aria-checked")).toBe("true");
  fireEvent.click(within(choice).getByRole("radio", { name: "Agent37" }));
  expect(screen.queryByRole("combobox", { name: "Region" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Set up" }));
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("cloud.brain.create", { service: "agent37" }));
  fireEvent.click(within(choice).getByRole("radio", { name: "Vercel" }));
  fireEvent.click(screen.getByRole("button", { name: "Set up" }));
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("cloud.brain.create", { region: "fra1", service: "vercel" }));
});

it("shows no choice of service with one connected", async () => {
  show({ state: "none", error: null }, "Europe/Berlin", null, [], null, "agent37");
  await screen.findByRole("button", { name: "Set up" });
  expect(screen.queryByRole("radiogroup")).toBeNull();
});

it("names where a ready brain runs, and offers to move it only once the other service is connected", async () => {
  show(ready);
  expect(await screen.findByText("Vercel · Singapore")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /^Move to/ })).toBeNull();
  cleanup();
  queryClient.clear();
  show(ready, "Asia/Manila", null, [], null, "vercel", undefined, ["vercel", "agent37"]);
  expect(await screen.findByRole("button", { name: "Move to Agent37" })).toBeTruthy();
});

it("moves only once the confirm says what happens, Cancel leaving it be", async () => {
  const pocket: RemoteDevice = { id: "phone-1", name: "Pocket", createdAt: 1, lastSeenAt: null, connected: false };
  show(ready, "Asia/Manila", null, [pocket], "chatgpt", "vercel", undefined, ["vercel", "agent37"]);
  fireEvent.click(await screen.findByRole("button", { name: "Move to Agent37" }));
  const dialog = await screen.findByRole("dialog", { name: "Move the cloud brain to Agent37?" });
  await waitFor(() => expect(dialog.textContent).toContain("Its threads come to this Mac first, then go to a new brain on Agent37. Phones need pairing again, and it takes a few minutes."));
  await waitFor(() => expect(dialog.textContent).toContain("Its Codex sign-in doesn't move. Sign in again after."));
  expect(within(dialog).queryByRole("combobox", { name: "Region" })).toBeNull();
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(core.call).not.toHaveBeenCalledWith("cloud.brain.move", expect.anything());
  fireEvent.click(screen.getByRole("button", { name: "Move to Agent37" }));
  fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Move" }));
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("cloud.brain.move", { to: "agent37" }));
});

it("asks for a region when moving to Vercel", async () => {
  show({ ...ready, service: "agent37", region: null }, "Europe/Berlin", null, [], null, "agent37", undefined, ["vercel", "agent37"]);
  fireEvent.click(await screen.findByRole("button", { name: "Move to Vercel" }));
  const dialog = await screen.findByRole("dialog", { name: "Move the cloud brain to Vercel?" });
  expect(dialog.textContent).toContain("It takes a few minutes.");
  expect((within(dialog).getByRole("combobox", { name: "Region" }) as HTMLSelectElement).value).toBe("fra1");
  fireEvent.change(within(dialog).getByRole("combobox", { name: "Region" }), { target: { value: "lhr1" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Move" }));
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("cloud.brain.move", { to: "vercel", region: "lhr1" }));
});

const moving: Extract<CloudBrainStatus, { state: "moving" }> = {
  state: "moving",
  service: "vercel",
  region: "sin1",
  to: { service: "agent37", region: null },
  step: "home",
  threads: { done: 2, of: 5 },
  setup: null,
  error: null,
};
const steps = () => within(screen.getByRole("list", { name: "Moving the cloud brain" })).getAllByRole("listitem");

it("shows each step of a move, with the threads moved so far and what setting up is at", async () => {
  show(moving);
  expect(await screen.findByText("Moving to Agent37")).toBeTruthy();
  expect(steps().map((step) => [step.getAttribute("data-state"), step.textContent])).toEqual([
    ["running", "Bring threads to this Mac2 of 5"],
    ["pending", "Set up on Agent37"],
    ["pending", "Remove it from Vercel"],
    ["pending", "Move threads back"],
  ]);
  expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
  cleanup();
  queryClient.clear();
  show({ ...moving, step: "setting-up", threads: null, setup: "start" });
  await screen.findByText("Moving to Agent37");
  expect(steps().map((step) => step.getAttribute("data-state"))).toEqual(["done", "running", "pending", "pending"]);
  expect(steps()[1]!.textContent).toBe("Set up on Agent37Starting it");
  cleanup();
  queryClient.clear();
  show({ ...moving, service: "agent37", region: null, step: "back", threads: { done: 1, of: 5 } });
  await screen.findByText("Moving to Agent37");
  expect(steps()[3]!.textContent).toBe("Move threads back1 of 5");
});

it("shows where a move stopped and why, and goes on from there", async () => {
  show({ ...moving, step: "removing", threads: null, error: "Could not remove the cloud brain's door. Vercel answered 500." });
  expect(await screen.findByText("Stopped")).toBeTruthy();
  expect(steps()[2]!.getAttribute("data-state")).toBe("failed");
  expect(within(steps()[2]!).getByRole("alert").textContent).toBe("Could not remove the cloud brain's door. Vercel answered 500.");
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("cloud.brain.move", { to: "agent37" }));
  fireEvent.click(screen.getByRole("button", { name: "Stay on Vercel" }));
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("cloud.brain.move.cancel", {}));
  cleanup();
  queryClient.clear();
  show({ ...moving, service: "agent37", region: null, step: "back", threads: { done: 1, of: 5 }, error: "The package could not be written." });
  expect(await screen.findByRole("button", { name: "Leave them on this Mac" })).toBeTruthy();
});

it("says why a move did not happen, on the brain that stayed, until dismissed", async () => {
  show({ ...ready, note: "Didn't move to Agent37. A thread is still working on the cloud brain. Try again once it's done." });
  expect((await screen.findByRole("alert")).textContent).toBe("Didn't move to Agent37. A thread is still working on the cloud brain. Try again once it's done.");
  fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("cloud.brain.move.dismiss", {}));
});

it("asks to pair the phone again after a move, with the one pair action", async () => {
  show({ ...ready, service: "agent37", region: null, pairAgain: true });
  const row = (await screen.findByText("Pair your phone again")).closest(".settings-field") as HTMLElement;
  expect(within(row).getByText("Phones paired before the move can't reach it.")).toBeTruthy();
  expect(screen.getAllByRole("button", { name: "Pair phone" })).toHaveLength(1);
  fireEvent.click(within(row).getByRole("button", { name: "Pair phone" }));
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("cloud.brain.pair", {}));
});

it("puts the last failure under the brain's own row, with a way to try again", async () => {
  show({ ...ready, machine: "awake", error: "Could not reach OpenOrc's server in the cloud instance." });
  const failure = await screen.findByText("Could not reach OpenOrc's server in the cloud instance.");
  expect(failure.getAttribute("role")).toBe("alert");
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("cloud.brain.wake", {}));
});
