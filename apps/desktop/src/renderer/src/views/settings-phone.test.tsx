import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { PairingOfferView, RemoteDevice, RemotePushStatus, RemoteStatus, RpcMethod, RpcResults } from "@openorc/protocol";
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
let push: RemotePushStatus;
let tested: RpcResults["remote.push.test"];

/** The core's side of phone access, kept in memory: offers expire, cancel and redeem the way remote-access.ts does. */
async function fakeCore(method: RpcMethod, params: Record<string, unknown>): Promise<unknown> {
  const status = (): RemoteStatus => ({
    listener,
    devices: structuredClone(devices),
    pairing: offer && Date.now() < offer.expiresAt ? { offerId: offer.offerId, expiresAt: offer.expiresAt } : null,
    push: { ...push },
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
    case "remote.push.setKey":
      // The core refuses anything but a P-256 key; this fake knows one by its armor.
      if (!String(params.pem).startsWith("-----BEGIN PRIVATE KEY-----")) throw new Error("This is not an Apple push key.");
      push = { ...push, keyId: String(params.keyId), problem: null };
      return status();
    case "remote.push.removeKey":
      push = { ...push, keyId: null, problem: null };
      return status();
    case "remote.push.test":
      return tested;
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
  push = { keyId: null, phones: 0, problem: null };
  tested = { sent: 0, failed: 0, problem: null };
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

describe("notifications on phones", () => {
  const PEM = "-----BEGIN PRIVATE KEY-----\nMIGTAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBHkwdwIBAQQg\n-----END PRIVATE KEY-----\n";
  // jsdom's File has no text(), which Chromium's has.
  const keyFile = (name: string, text = PEM) => Object.assign(new File([text], name), { text: async () => text });
  const notifications = async () => (await screen.findByRole("heading", { name: "Notifications" })).closest<HTMLElement>("section")!;
  const choose = (section: HTMLElement, file: File) => fireEvent.change(section.querySelector<HTMLInputElement>('input[type="file"]')!, { target: { files: [file] } });

  it("appears once phone access is on, with no key yet", async () => {
    show();
    const toggle = await screen.findByRole("switch", { name: "Allow paired phones" });
    await waitFor(() => expect(toggle).toHaveProperty("disabled", false));
    expect(screen.queryByRole("heading", { name: "Notifications" })).toBeNull();
    fireEvent.click(toggle);
    const section = await notifications();
    expect(within(section).getByText("Apple push key")).toBeTruthy();
    expect(within(section).getByText("Not added")).toBeTruthy();
    const input = section.querySelector<HTMLInputElement>('input[type="file"]')!;
    expect(input.accept).toBe(".p8");
    const opened = vi.spyOn(input, "click");
    fireEvent.click(within(section).getByRole("button", { name: "Add key" }));
    expect(opened).toHaveBeenCalledOnce();
  });

  it("adds the key from Apple's file, reading its id from the file's name", async () => {
    listener = on;
    show();
    const section = await notifications();
    choose(section, keyFile("AuthKey_ABC123DEFG.p8"));
    expect(await within(section).findByText("Key ABC123DEFG")).toBeTruthy();
    expect(calls("remote.push.setKey")).toEqual([["remote.push.setKey", { keyId: "ABC123DEFG", pem: PEM }]]);
    expect(within(section).getByRole("button", { name: "Send a test" })).toBeTruthy();
    expect(within(section).queryByRole("alert")).toBeNull();
  });

  it.each(["key.p8", "AuthKey_ABC123DEFG (1).p8", "AuthKey_abc123defg.p8"])("asks for Apple's file with its name unchanged, not %s", async (name) => {
    listener = on;
    show();
    const section = await notifications();
    choose(section, keyFile(name));
    expect((await within(section).findByRole("alert")).textContent).toBe("Choose the AuthKey file from Apple, with its name unchanged.");
    expect(calls("remote.push.setKey")).toEqual([]);
    expect(within(section).getByText("Not added")).toBeTruthy();
  });

  it("says when the file is not an Apple push key", async () => {
    listener = on;
    show();
    const section = await notifications();
    choose(section, keyFile("AuthKey_ABC123DEFG.p8", "ssh-ed25519 AAAA"));
    expect((await within(section).findByRole("alert")).textContent).toBe("This is not an Apple push key.");
    expect(within(section).getByText("Not added")).toBeTruthy();
  });

  it.each([
    [{ reason: "BadEnvironmentKeyIdInToken", environment: "sandbox" }, "This key can't reach builds from Xcode. Add a Sandbox key."],
    [{ reason: "BadEnvironmentKeyIdInToken", environment: "production" }, "Apple did not accept this key (BadEnvironmentKeyIdInToken)."],
    [{ reason: "InvalidProviderToken", environment: "sandbox" }, "Apple did not accept this key (InvalidProviderToken)."],
  ] as const)("explains Apple's refusal %o", async (problem, line) => {
    listener = on;
    push = { keyId: "ABC123DEFG", phones: 1, problem };
    show();
    expect((await within(await notifications()).findByRole("alert")).textContent).toBe(line);
  });

  it.each([
    [0, { sent: 0, failed: 0, problem: null }, "No phone has notifications on."],
    [1, { sent: 1, failed: 0, problem: null }, "Sent to 1 phone."],
    [3, { sent: 3, failed: 0, problem: null }, "Sent to 3 phones."],
    [2, { sent: 0, failed: 0, problem: { reason: "BadEnvironmentKeyIdInToken", environment: "sandbox" } }, "This key can't reach builds from Xcode. Add a Sandbox key."],
    [2, { sent: 0, failed: 2, problem: null }, "The test did not go through."],
  ] as const)("says what a test reached with %i phones registered", async (phones, result, line) => {
    listener = on;
    push = { keyId: "ABC123DEFG", phones, problem: null };
    tested = result;
    show();
    const section = await notifications();
    fireEvent.click(await within(section).findByRole("button", { name: "Send a test" }));
    await waitFor(() => expect(within(section).getByText(line)).toBeTruthy());
    expect(calls("remote.push.test")).toEqual([["remote.push.test", {}]]);
  });

  it("removes the key", async () => {
    listener = on;
    push = { keyId: "ABC123DEFG", phones: 1, problem: { reason: "InvalidProviderToken", environment: "sandbox" } };
    show();
    const section = await notifications();
    fireEvent.click(await within(section).findByRole("button", { name: "Remove" }));
    expect(await within(section).findByText("Not added")).toBeTruthy();
    expect(calls("remote.push.removeKey")).toEqual([["remote.push.removeKey", {}]]);
    expect(within(section).queryByRole("alert")).toBeNull();
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
