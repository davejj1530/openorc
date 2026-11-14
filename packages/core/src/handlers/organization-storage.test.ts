import { expect, it, vi } from "vitest";
import { createOrganizationStorageHandlers } from "./organization-storage.js";

it("keeps storage scoped to the explicit organization and returns a read refusal unchanged", async () => {
  const result = { storage: null, error: "Only an admin can do that." };
  const storage = vi.fn(async () => result);
  expect(await createOrganizationStorageHandlers({ storage })["organization.storage.get"]({ spaceId: "team-b" })).toEqual(result);
  expect(storage).toHaveBeenCalledExactlyOnceWith("team-b");
  expect(() => createOrganizationStorageHandlers(null)["organization.storage.get"]({ spaceId: "team-b" })).toThrow("isn't available");
});
