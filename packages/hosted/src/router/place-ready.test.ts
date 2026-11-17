import type { HostedThreads } from "../index.js";
import { describe, expect, it, vi } from "vitest";
import { PlaceRouter } from "./place-router.js";

/** A start made ready from New thread in a space, as the composer asks it: with the space it is in. */
const asked = { projectId: "mac-openorc", spaceId: "team", agent: "claude", mode: "act", permissionMode: "autonomous" } as const;
const ask = { type: "rpc" as const, id: 1, method: "threads.readyStart", params: asked };

function router(project: { key: string; hostedProjectId: string | null }, active = true) {
  const readyStart = vi.fn(async () => undefined);
  const next = vi.fn(async () => ({ type: "rpc.error" as const, id: 1, message: "not the Mac's" }));
  const place = { active, readyStart, holds: () => false } as unknown as HostedThreads;
  const spaces = { status: () => ({ state: "ready", personalSpaceId: "me" }), projects: async () => [{ ...project, localProjectId: project.key }], people: async () => [] } as never;
  return { readyStart, next, router: new PlaceRouter({ place: () => place, spaces: () => spaces, next }) };
}

describe("a new cloud thread made ready in a space", () => {
  it("reaches the space's place when the space holds the project on OpenOrc Cloud", async () => {
    const { readyStart, next, router: placed } = router({ key: "mac-openorc", hostedProjectId: "cloud-openorc" });
    expect(await placed.handle(ask)).toEqual({ type: "rpc.result", id: 1, result: null });
    expect(readyStart).toHaveBeenCalledExactlyOnceWith(asked);
    expect(next).not.toHaveBeenCalled();
  });

  it("answers with nothing, and asks nothing, for a project the space holds only on this Mac or with no account", async () => {
    for (const [project, active] of [
      [{ key: "mac-openorc", hostedProjectId: null }, true],
      [{ key: "mac-openorc", hostedProjectId: "cloud-openorc" }, false],
    ] as const) {
      const { readyStart, router: placed } = router(project, active);
      expect(await placed.handle(ask)).toEqual({ type: "rpc.result", id: 1, result: null });
      expect(readyStart).not.toHaveBeenCalled();
    }
  });
});
