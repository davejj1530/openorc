// @vitest-environment jsdom
import type { RpcMethod } from "@openorc/protocol";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { FakeMac } from "../test-fixtures/fake-mac";
import { useComposerModels } from "./claude-account";

const mac = vi.hoisted(() => ({ phone: null as FakeMac | null, catalog: null as unknown, asked: [] as string[] }));
vi.mock("../client", async () => {
  const { fakeMac } = await import("../test-fixtures/fake-mac");
  mac.phone = fakeMac((method: RpcMethod) => {
    mac.asked.push(method);
    if (method === "cloudModels.catalog") return Promise.resolve(mac.catalog);
    if (method === "agents.models") return Promise.resolve([{ id: "gpt-6-sol", label: "GPT-6 Sol", agent: "codex", isDefault: true }]);
    return Promise.reject(new Error(`no ${method}`));
  });
  return mac.phone.module;
});

afterEach(() => {
  cleanup();
  mac.phone!.module.client.queryClient.clear();
  mac.asked = [];
});

const settings = (cloud: boolean) => ({ choice: null, selectModel: () => undefined, cloud });
const ids = (data: { id: string }[] | undefined) => data?.map((model) => model.id);

it("offers a cloud turn the models OpenOrc Cloud runs, without asking the Mac for its own", async () => {
  mac.catalog = { models: [{ id: "", label: "Default", agent: "claude", isDefault: true }], providers: [] };
  const { result } = renderHook(() => useComposerModels(settings(true)), { wrapper: mac.phone!.wrapper });
  await waitFor(() => expect(ids(result.current.data)).toEqual([""]));
  expect(mac.asked).not.toContain("agents.models");
});

it("offers the Mac's models where the server keeps no catalog, and for a turn on the Mac", async () => {
  mac.catalog = null;
  const cloud = renderHook(() => useComposerModels(settings(true)), { wrapper: mac.phone!.wrapper });
  await waitFor(() => expect(ids(cloud.result.current.data)).toEqual(["gpt-6-sol"]));
  cleanup();
  mac.phone!.module.client.queryClient.clear();
  mac.asked = [];
  const local = renderHook(() => useComposerModels(settings(false)), { wrapper: mac.phone!.wrapper });
  await waitFor(() => expect(ids(local.result.current.data)).toEqual(["gpt-6-sol"]));
  expect(mac.asked).not.toContain("cloudModels.catalog");
});
