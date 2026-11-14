import { expect, it, vi } from "vitest";
import { onlineTaskKey, readOnlineTaskPages } from "./online-tasks.js";

it("partitions identical organization queries by the signed-in account", () => {
  expect(onlineTaskKey({ accountId: "a", spaceId: "org:studio" }, "list")).not.toEqual(onlineTaskKey({ accountId: "b", spaceId: "org:studio" }, "list"));
});
it("waits for the final page and refuses a changing access revision", async () => {
  const read = vi.fn().mockResolvedValueOnce({ accessRevision: 1, tasks: [], cursor: "next" }).mockResolvedValueOnce({ accessRevision: 2, tasks: [], cursor: null });
  await expect(readOnlineTaskPages(read, { spaceId: "org:studio" })).rejects.toThrow("Project access changed");
  expect(read.mock.calls[1]?.[0]).toEqual({ spaceId: "org:studio", cursor: "next" });
});
it("fails an incomplete or repeating page instead of reporting an empty list", async () => {
  const failed = vi.fn().mockResolvedValueOnce({ accessRevision: 1, tasks: [], cursor: "next" }).mockRejectedValueOnce(new Error("Offline"));
  await expect(readOnlineTaskPages(failed, { spaceId: "org:studio" })).rejects.toThrow("Offline");
  const repeated = vi.fn().mockResolvedValue({ accessRevision: 1, tasks: [], cursor: "same" });
  await expect(readOnlineTaskPages(repeated, { spaceId: "org:studio" })).rejects.toThrow("couldn't finish");
  expect(repeated).toHaveBeenCalledTimes(2);
});
