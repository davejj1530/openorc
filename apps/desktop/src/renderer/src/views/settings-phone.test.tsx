import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { PairingOfferView, RemoteDevice, RemoteStatus, RpcMethod } from "@openorc/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invalidateTags, queryClient } from "../lib/client";
import { core } from "../lib/rpc";
import { PairPhone, PhoneSettings } from "./settings-phone";

vi.mock("../lib/rpc", () => ({ core: { call: vi.fn(), onReady: vi.fn(), onPush: () => () => {} } }));

const on: RemoteStatus["listener"] = {
  state: "on",
  port: 47820,
  routes: [
    { kind: "lan", host: "studio.local", port: 47820 },
    { kind: "tailnet", host: "100.101.102.103", port: 47820 },
  ],
};
let listener: RemoteStatus["listener"];
let devices: RemoteDevice[];
let offer: PairingOfferView | null;
let offers: number;
/** How long a status read takes. The real core answers over IPC, after a begin's own reply. */
let statusDelay: number;

/** The core's side of phone access, kept in memory: offers expire, cancel and redeem the way remote-access.ts does. */
async function fakeCore(method: RpcMethod, params: Record<string, unknown>): Promise<unknown> {
  const status = (): RemoteStatus => ({
    listener,
    devices: structuredClone(devices),
    pairing: offer && Date.now() < offer.expiresAt ? { offerId: offer.offerId, expiresAt: offer.expiresAt } : null,
  });
  switch (method) {
    case "remote.status":
      await new Promise((resolve) => setTimeout(resolve, statusDelay));
      return status();
    case "remote.configure":
      listener = params.enabled ? on : { state: "off" };
      return status();
    case "remote.pairing.begin":
      offers += 1;
      offer = { offerId: `offer-${offers}`, url: `openorc://pair#v1.${"eyJuYW1lIjoiU3R1ZGlvIn0".repeat(12)}${offers}`, expiresAt: Date.now() + 300_000 };
      return offer;
    case "remote.pairing.cancel":
      if (offer?.offerId === params.offerId) offer = null;
      return null;
    case "remote.devices.remove":
      devices = devices.filter((device) => device.id !== params.id);
      return null;
    default:
      throw new Error(`Unexpected ${method}`);
  }
}

const calls = (method: RpcMethod) => vi.mocked(core.call).mock.calls.filter(([called]) => called === method);
const show = () =>
  render(
    <QueryClientProvider client={queryClient}>
      <PairPhone />
      <PhoneSettings active />
    </QueryClientProvider>,
  );

beforeEach(() => {
  listener = { state: "off" };
  devices = [];
  offer = null;
  offers = 0;
  statusDelay = 0;
  vi.mocked(core.call).mockImplementation((method, params) => fakeCore(method, params as Record<string, unknown>) as never);
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.resetAllMocks();
});

describe("phone access", () => {
  it("starts as one switch, and turning it on offers pairing", async () => {
    show();
    const toggle = await screen.findByRole("switch", { name: "Allow paired phones" });
    await waitFor(() => expect(toggle).toHaveProperty("disabled", false));
    expect(toggle).toHaveProperty("checked", false);
    expect(screen.queryByRole("button", { name: "Pair a phone" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Paired phones" })).toBeNull();
    fireEvent.click(toggle);
    expect(await screen.findByRole("button", { name: "Pair a phone" })).toBeTruthy();
    expect(calls("remote.configure")).toEqual([["remote.configure", { enabled: true }]]);
    expect(toggle).toHaveProperty("checked", true);
    expect(screen.getByRole("heading", { name: "Paired phones" })).toBeTruthy();
    expect(screen.getByText("No paired phones yet.")).toBeTruthy();
  });

  it("keeps this Mac's addresses closed until asked for", async () => {
    listener = on;
    show();
    const details = (await screen.findByText("Addresses")).closest("details")!;
    expect(details.open).toBe(false);
    expect(within(details).getByText("studio.local:47820").nextElementSibling?.textContent).toBe("Same network");
    expect(within(details).getByText("100.101.102.103:47820").nextElementSibling?.textContent).toBe("Tailscale");
  });

  it("shows why phones cannot connect, and tries again", async () => {
    listener = { state: "failed", reason: "Port 47820 is in use." };
    show();
    expect((await screen.findByRole("alert")).textContent).toContain("Port 47820 is in use.");
    expect(screen.getByRole("switch", { name: "Allow paired phones" })).toHaveProperty("checked", true);
    expect(screen.queryByRole("button", { name: "Pair a phone" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("button", { name: "Pair a phone" })).toBeTruthy();
    expect(calls("remote.configure")).toEqual([["remote.configure", { enabled: true }]]);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("lists paired phones by presence, and removes only the chosen one", async () => {
    const now = Date.now();
    devices = [
      { id: "phone-1", name: "David's iPhone", createdAt: now - 86_400_000, lastSeenAt: now, connected: true },
      { id: "phone-2", name: "Studio iPad", createdAt: now - 172_800_000, lastSeenAt: now - 3 * 3_600_000, connected: false },
    ];
    show();
    const iphone = (await screen.findByText("David's iPhone")).closest<HTMLElement>(".settings-field")!;
    const ipad = screen.getByText("Studio iPad").closest<HTMLElement>(".settings-field")!;
    expect(within(iphone).getByText("Connected")).toBeTruthy();
    expect(within(ipad).getByText("Last seen 3h ago")).toBeTruthy();
    fireEvent.click(within(ipad).getByRole("button", { name: "Remove Studio iPad" }));
    await waitFor(() => expect(screen.queryByText("Studio iPad")).toBeNull());
    expect(calls("remote.devices.remove")).toEqual([["remote.devices.remove", { id: "phone-2" }]]);
    expect(screen.getByText("David's iPhone")).toBeTruthy();
  });
});

describe("pairing a phone", () => {
  beforeEach(() => {
    listener = on;
    statusDelay = 20;
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"], shouldAdvanceTime: true });
  });
  afterEach(() => vi.useRealTimers());

  async function openSheet() {
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Pair a phone" }));
    const sheet = await screen.findByRole("dialog", { name: "Pair a phone" });
    await within(sheet).findByRole("img", { name: "Pairing code" });
    // The sheet closes itself only once the status has listed its offer, so wait for that refresh.
    await waitFor(() => expect(queryClient.getQueryData<RemoteStatus>(["remote.status", {}])?.pairing?.offerId).toBe("offer-1"));
    expect(screen.getByRole("dialog", { name: "Pair a phone" })).toBe(sheet);
    return sheet;
  }

  it("counts down to the code's expiry, then offers a new code", async () => {
    const sheet = await openSheet();
    expect(within(sheet).getByText("Expires in 5:00")).toBeTruthy();
    expect(within(sheet).queryByRole("button", { name: "New code" })).toBeNull();
    act(() => {
      vi.advanceTimersByTime(61_000);
    });
    expect(within(sheet).getByText("Expires in 3:59")).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(240_000);
    });
    fireEvent.click(within(sheet).getByRole("button", { name: "New code" }));
    expect(await within(sheet).findByText("Expires in 5:00")).toBeTruthy();
    expect(calls("remote.pairing.begin")).toHaveLength(2);
    expect(within(sheet).queryByRole("button", { name: "New code" })).toBeNull();
  });

  it("copies the pairing link, for a phone that pastes it instead of scanning", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const sheet = await openSheet();
    fireEvent.click(within(sheet).getByRole("button", { name: "Copy link" }));
    expect(await within(sheet).findByRole("button", { name: "Copied" })).toBeTruthy();
    expect(writeText).toHaveBeenCalledWith(offer!.url);
    act(() => {
      vi.advanceTimersByTime(300_000);
    });
    expect(within(sheet).queryByRole("button", { name: /Copy link|Copied/ })).toBeNull();
  });

  it("cancels the code when the sheet is closed", async () => {
    const sheet = await openSheet();
    fireEvent.click(within(sheet).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls("remote.pairing.cancel")).toEqual([["remote.pairing.cancel", { offerId: "offer-1" }]]);
  });

  it("closes itself when a phone pairs, without cancelling the spent code", async () => {
    await openSheet();
    offer = null;
    devices = [{ id: "phone-1", name: "David's iPhone", createdAt: Date.now(), lastSeenAt: Date.now(), connected: true }];
    act(() => invalidateTags(["remote"], { immediate: true }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByText("David's iPhone")).toBeTruthy();
    expect(calls("remote.pairing.cancel")).toEqual([]);
  });
});
