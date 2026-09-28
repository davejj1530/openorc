import { afterEach, expect, it, vi } from "vitest";
import { core } from "./rpc";
import { queryClient } from "./query";
import { saveDefaultPermission } from "./permission-default";

afterEach(() => {
  vi.restoreAllMocks();
  queryClient.clear();
});

it("persists rapid permission selections in order, retaining the most recent choice", async () => {
  let release!: () => void;
  const first = new Promise<void>((resolve) => {
    release = resolve;
  });
  const call = vi.spyOn(core, "call").mockImplementation(async (_method, params) => {
    if (call.mock.calls.length === 1) await first;
    return { defaultPermissionMode: (params as { defaultPermissionMode: string }).defaultPermissionMode } as never;
  });
  const a = saveDefaultPermission("autonomous");
  const b = saveDefaultPermission("review");
  await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(1));
  release();
  await Promise.all([a, b]);
  expect(call.mock.calls).toEqual([
    ["app.settings.set", { defaultPermissionMode: "autonomous" }],
    ["app.settings.set", { defaultPermissionMode: "review" }],
  ]);
  expect(queryClient.getQueryData(["app.settings.get", {}])).toMatchObject({ defaultPermissionMode: "review" });
});

it("can save again after a failed write", async () => {
  const call = vi
    .spyOn(core, "call")
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce({ defaultPermissionMode: "trusted" } as never);
  await expect(saveDefaultPermission("autonomous")).rejects.toThrow("offline");
  await saveDefaultPermission("trusted");
  expect(call).toHaveBeenCalledTimes(2);
  expect(queryClient.getQueryData(["app.settings.get", {}])).toMatchObject({ defaultPermissionMode: "trusted" });
});
