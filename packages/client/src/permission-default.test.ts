// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { testClient } from "./test-fixtures/fake-connection.js";

const { client, call } = testClient();

afterEach(() => {
  call.mockReset();
  client.queryClient.clear();
});

it("persists rapid permission selections in order, retaining the most recent choice", async () => {
  let release!: () => void;
  const first = new Promise<void>((resolve) => {
    release = resolve;
  });
  call.mockImplementation(async (_method, params) => {
    if (call.mock.calls.length === 1) await first;
    return { defaultPermissionMode: (params as { defaultPermissionMode: string }).defaultPermissionMode };
  });
  const a = client.saveDefaultPermission("autonomous");
  const b = client.saveDefaultPermission("review");
  await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(1));
  release();
  await Promise.all([a, b]);
  expect(call.mock.calls).toEqual([
    ["app.settings.set", { defaultPermissionMode: "autonomous" }],
    ["app.settings.set", { defaultPermissionMode: "review" }],
  ]);
  expect(client.queryClient.getQueryData(["app.settings.get", {}])).toMatchObject({ defaultPermissionMode: "review" });
});

it("can save again after a failed write", async () => {
  call.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({ defaultPermissionMode: "trusted" });
  await expect(client.saveDefaultPermission("autonomous")).rejects.toThrow("offline");
  await client.saveDefaultPermission("trusted");
  expect(call).toHaveBeenCalledTimes(2);
  expect(client.queryClient.getQueryData(["app.settings.get", {}])).toMatchObject({ defaultPermissionMode: "trusted" });
});

it("keeps a choice on its own work where the client may not change app settings", async () => {
  const phone = testClient(undefined, { savesDefaultPermission: false });
  phone.call.mockResolvedValue({ defaultPermissionMode: "trusted" });
  const { result } = renderHook(() => phone.client.usePermissionSelection(), { wrapper: phone.wrapper });
  await vi.waitFor(() => expect(result.current.permission).toBe("trusted"));
  act(() => result.current.select("autonomous"));
  expect(result.current.permission).toBe("autonomous");
  expect(result.current.error).toBeNull();
  expect(phone.call.mock.calls.map(([method]) => method)).not.toContain("app.settings.set");
});
