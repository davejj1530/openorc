// @vitest-environment jsdom
import type { PreviewState, RpcMethod } from "@openorc/protocol";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fixtureThreads } from "../home/test-fixtures/threads";
import type { FakeMac } from "../test-fixtures/fake-mac";
import { usePreviewPanel } from "./use-preview-panel";

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

it("names the page the Mac shows for the thread", async () => {
  const { result } = renderHook(() => usePreviewPanel(settings), { wrapper: mac.phone!.wrapper });
  await waitFor(() => expect(result.current).toEqual({ page: "QA Page" }));
  expect(mac.asked).toEqual([{ method: "preview.state", params: { threadId: "t-settings" } }]);
});

it("keeps Preview with no page once the Mac says the thread's page closed", async () => {
  const { result } = renderHook(() => usePreviewPanel(settings), { wrapper: mac.phone!.wrapper });
  await waitFor(() => expect(result.current).toEqual({ page: "QA Page" }));
  mac.state = { open: false };
  act(() => mac.phone!.module.client.invalidateTags(["preview:t-settings"]));
  await waitFor(() => expect(result.current).toEqual({ page: null }));
});

it("lists no Preview from a Mac that does not know it", async () => {
  mac.refuse = "This is not available from a phone.";
  const { result } = renderHook(() => usePreviewPanel(settings), { wrapper: mac.phone!.wrapper });
  await waitFor(() => expect(mac.asked.length).toBeGreaterThan(0));
  // The client asks once more before it settles on the refusal.
  await waitFor(() => expect(result.current).toBeNull(), { timeout: 3000 });
});

it("asks nothing before the thread is read", async () => {
  const { result } = renderHook(() => usePreviewPanel(null), { wrapper: mac.phone!.wrapper });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(result.current).toBeNull();
  expect(mac.asked).toEqual([]);
});
