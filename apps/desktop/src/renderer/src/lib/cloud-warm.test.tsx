import { renderHook } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { useCloudWarm } from "./cloud-warm";
import { queryClient } from "./client";
import { core } from "./rpc";

vi.mock("./rpc", () => ({ core: { call: vi.fn(async () => null), onReady: vi.fn(), onPush: () => () => {} } }));
afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(core.call).mockClear();
});

const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
const warmed = () => vi.mocked(core.call).mock.calls.filter(([method]) => method === "cloud.warm");

it("asks for the cloud to get ready at the first keystroke, then at most once a minute while typing goes on", async () => {
  let now = 1_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const hook = renderHook(({ prompt }) => useCloudWarm("p1", "claude", prompt), { wrapper, initialProps: { prompt: "" } });
  hook.rerender({ prompt: "F" });
  hook.rerender({ prompt: "Fi" });
  await vi.waitFor(() => expect(warmed()).toEqual([["cloud.warm", { projectId: "p1", agent: "claude" }]]));
  now += 61_000;
  hook.rerender({ prompt: "Fix" });
  await vi.waitFor(() => expect(warmed()).toHaveLength(2));
});

it("asks nothing for a draft opened again, for one not in the cloud, or for an agent that does not run there", async () => {
  const reopened = renderHook(({ prompt }) => useCloudWarm("p1", "claude", prompt), { wrapper, initialProps: { prompt: "Written before" } });
  reopened.rerender({ prompt: "Written before" });
  renderHook(() => useCloudWarm(null, "claude", "Typed"), { wrapper }).rerender();
  const acp = renderHook(({ prompt }) => useCloudWarm("p1", "acp", prompt), { wrapper, initialProps: { prompt: "" } });
  acp.rerender({ prompt: "Typed" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(warmed()).toEqual([]);
});
