import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { AccountStatus } from "@openorc/protocol";
import { accountSeatState, useAccountSeatState } from "./account-seat-state";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const account: Extract<AccountStatus, { state: "signed-in" }> = {
  state: "signed-in",
  email: "person@example.com",
  name: "Alex",
  image: null,
  reach: "offline",
  plan: { pro: true, standing: "grace", at: 1000 },
  hours: { leftSeconds: 21600, monthly: null, packsLeftSeconds: 21600 },
  organizationAccess: { state: "grace", reason: "seat_removed", until: 1000, message: "Your seat was taken back; you have one day to get Pro to keep using organizations." },
  allowanceSource: null,
  paidBy: "organization",
  sandbox: null,
  signIns: null,
  signingIn: {},
  github: null,
  connectingGithub: null,
  projects: [],
  paying: null,
  error: null,
};

it("keeps the authoritative packs usable until the deadline and hides stale usability at it", () => {
  expect(accountSeatState(account, 999)).toBe(account);
  expect(accountSeatState(account, 1000)).toMatchObject({
    organizationAccess: { state: "frozen", message: "Your seat was taken back, and your day of grace has ended." },
    plan: { pro: false },
    hours: null,
  });
  expect(account.hours?.packsLeftSeconds).toBe(21600);
});

it("accepts paid recovery without inventing or combining another allowance", () => {
  const recovered = {
    ...account,
    organizationAccess: { state: "active", reason: null, until: null, message: null },
    plan: { pro: true, standing: "live", at: 2000 },
    allowanceSource: { kind: "self" },
  } satisfies typeof account;
  expect(accountSeatState(recovered, 1500)).toBe(recovered);
});

it("preserves old-server personal behavior when the gate is absent", () => {
  const { organizationAccess: _access, ...old } = account;
  expect(accountSeatState(old, 1500)).toBe(old);
});

it("repaints at the exact offline deadline and never restores an expired response", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const hook = renderHook(({ value }) => useAccountSeatState(value), { initialProps: { value: account } });
  await act(() => vi.advanceTimersByTime(999));
  expect(hook.result.current.account).toMatchObject({ organizationAccess: { state: "grace" }, hours: { leftSeconds: 21600 } });
  await act(() => vi.advanceTimersByTime(1));
  expect(hook.result.current.account).toMatchObject({ organizationAccess: { state: "frozen" }, hours: null });
  hook.rerender({ value: { ...account } });
  expect(hook.result.current.account).toMatchObject({ organizationAccess: { state: "frozen" } });
});

it("rechecks the deadline immediately when the suspended window receives focus", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const hook = renderHook(() => useAccountSeatState(account));
  vi.setSystemTime(2000);
  await act(() => window.dispatchEvent(new Event("focus")));
  expect(hook.result.current.account).toMatchObject({ organizationAccess: { state: "frozen" } });
});
