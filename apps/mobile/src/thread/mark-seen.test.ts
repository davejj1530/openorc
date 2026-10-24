// @vitest-environment jsdom
import type { ThreadSummary } from "@openorc/protocol";
import { cleanup, renderHook } from "@testing-library/react";
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { FakeLink } from "../test-fixtures/fake-link";
import { useMarkSeen } from "./mark-seen";

/** The phone's link as far as the mark sees it: which session it has, if any. */
const phone = vi.hoisted(() => ({ mutate: vi.fn(), link: null as FakeLink | null }));

vi.mock("../client", async () => {
  const { fakeLink } = await import("../test-fixtures/fake-link");
  phone.link = fakeLink();
  return { useSession: phone.link.useSession, useRpcMutation: () => ({ mutate: phone.mutate }) };
});

afterEach(cleanup);

const unread = { id: "thread", unread: true, lastActivityAt: 1 } as ThreadSummary;

it("marks the thread read, and again on each new session while the Mac still says unread", () => {
  renderHook(() => useMarkSeen(unread));
  expect(phone.mutate).toHaveBeenCalledTimes(1);
  act(() => phone.link!.to(null));
  expect(phone.mutate).toHaveBeenCalledTimes(1);
  act(() => phone.link!.to(2));
  expect(phone.mutate).toHaveBeenCalledTimes(2);
  // The phone moves to the LAN: one session follows another, and a mark the old one dropped goes again.
  act(() => phone.link!.to(3));
  expect(phone.mutate).toHaveBeenCalledTimes(3);
  expect(phone.mutate).toHaveBeenLastCalledWith({ id: "thread", patch: { seen: true } });
});
