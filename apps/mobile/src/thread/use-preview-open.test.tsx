// @vitest-environment jsdom
import type { PreviewState, RpcMethod } from "@openorc/protocol";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fixtureThreads } from "../home/test-fixtures/threads";
import type { FakeMac } from "../test-fixtures/fake-mac";
import { usePreviewOpen } from "./use-preview-open";

const live: PreviewState = { open: true, pane: "p1", address: "http://127.0.0.1:47831/", title: "QA Page", phase: "live", error: null, frame: null };
const mac = vi.hoisted(() => ({ phone: null as FakeMac | null, state: null as PreviewState | null, refuse: null as string | null, asked: [] as { method: RpcMethod; params: unknown }[] }));
vi.mock("../client", async () => {
  const { fakeMac } = await import("../test-fixtures/fake-mac");
  mac.phone = fakeMac((method, params) => {
    mac.asked.push({ method, params });
    if (method !== "preview.state") return Promise.resolve(null);
    return mac.refuse ? Promise.reject(new Error(mac.refuse)) : Promise.resolve(mac.state);
  });
  return mac.phone.module;
});

beforeEach(() => {
  mac.state = live;
  mac.refuse = null;
  mac.asked.length = 0;
  mac.phone!.module.queryClient.clear();
});
afterEach(cleanup);

const settings = fixtureThreads.find((thread) => thread.id === "t-settings")!;

it("lists Preview while the Mac shows a page for the thread", async () => {
  const { result } = renderHook(() => usePreviewOpen(settings), { wrapper: mac.phone!.wrapper });
  await waitFor(() => expect(result.current).toBe(true));
  expect(mac.asked).toEqual([{ method: "preview.state", params: { threadId: "t-settings" } }]);
});

it("takes Preview away when the Mac says the thread's page closed", async () => {
  const { result } = renderHook(() => usePreviewOpen(settings), { wrapper: mac.phone!.wrapper });
  await waitFor(() => expect(result.current).toBe(true));
  mac.state = { open: false };
  act(() => mac.phone!.module.client.invalidateTags(["preview:t-settings"]));
  await waitFor(() => expect(result.current).toBe(false));
});

it("lists no Preview from a Mac that does not know it", async () => {
  mac.refuse = "This is not available from a phone.";
  const { result } = renderHook(() => usePreviewOpen(settings), { wrapper: mac.phone!.wrapper });
  await waitFor(() => expect(mac.asked.length).toBeGreaterThan(0));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(result.current).toBe(false);
});

it("asks nothing before the thread is read", async () => {
  const { result } = renderHook(() => usePreviewOpen(null), { wrapper: mac.phone!.wrapper });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(result.current).toBe(false);
  expect(mac.asked).toEqual([]);
});
