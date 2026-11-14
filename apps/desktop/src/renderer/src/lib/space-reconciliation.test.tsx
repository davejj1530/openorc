import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SpaceProject, SpacesStatus } from "@openorc/protocol";
import { core } from "./rpc";
import { spaceNavigation } from "./space-navigation";
import { reconcileSpaceNavigation } from "./space-queries";

beforeEach(() => {
  vi.spyOn(core, "call").mockResolvedValue([]);
});

const status: Extract<SpacesStatus, { state: "ready" }> = {
  state: "ready",
  userId: "person",
  apiOrigin: "https://cloud.example.com",
  personalSpaceId: "personal",
  spaces: [
    { kind: "personal", id: "personal" },
    { kind: "organization", id: "birch", name: "Birch", logo: null, memberId: "member", role: "admin", memberCount: 1 },
  ],
  create: { allowed: true, reason: null },
  invitations: [],
  reach: "live",
  heardAt: 1,
  error: null,
};

afterEach(() => {
  spaceNavigation.getState().end();
  localStorage.clear();
  sessionStorage.clear();
  vi.restoreAllMocks();
});

it("waits for a superseding read before an explicit opening selects the new organization", async () => {
  const first = Promise.withResolvers<SpaceProject[]>();
  const second = Promise.withResolvers<SpaceProject[]>();
  vi.mocked(core.call).mockResolvedValue([]).mockReturnValueOnce(first.promise).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise).mockReturnValueOnce(second.promise);
  let opened = false;
  const opening = reconcileSpaceNavigation(status, "core").then(() => {
    opened = true;
    spaceNavigation.getState().select("birch");
  });
  const background = reconcileSpaceNavigation(status, "core");
  first.resolve([]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(opened).toBe(false);
  second.resolve([]);
  await Promise.all([opening, background]);
  expect(spaceNavigation.getState().current).toBe("birch");
});

it("keeps the existing local navigation when the account has no organization", async () => {
  await reconcileSpaceNavigation({ ...status, spaces: [{ kind: "personal", id: "personal" }] }, "core");
  expect(core.call).not.toHaveBeenCalled();
  expect(spaceNavigation.getState().key).toBeNull();
});
