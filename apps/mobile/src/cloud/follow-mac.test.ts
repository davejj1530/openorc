import type { ClientPush } from "@openorc/client";
import { CLOUD_SESSION } from "@openorc/protocol";
import { expect, it, vi } from "vitest";
import type { LinkState } from "../connection/manager";
import { followMac, type FollowedLink } from "./follow-mac";

const studio = { id: "studio", name: "Studio" };
const route = { kind: "lan", host: "studio.local", port: 1 } as const;
const connected = (serial: number): LinkState => ({ kind: "connected", mac: studio, route, serial });

/** A link whose state, shared capabilities and pushes a test sets, and the cloud it drives. */
function world(shares: readonly string[] = [CLOUD_SESSION]) {
  let state: LinkState = { kind: "connecting", mac: studio, why: null };
  const listeners = new Set<() => void>();
  const pushes = new Set<(push: ClientPush) => void>();
  const asked: string[] = [];
  const link: FollowedLink = {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    connection: {
      shares: async (capability) => shares.includes(capability),
      device: (async (method: string) => {
        asked.push(method);
        return null;
      }) as FollowedLink["connection"]["device"],
      onPush: (listener) => {
        pushes.add(listener);
        return () => void pushes.delete(listener);
      },
    },
  };
  const cloud = {
    follow: vi.fn(async (source: Parameters<Parameters<typeof followMac>[1]["follow"]>[0]) => void (await source.owner())),
    release: vi.fn(async () => undefined),
  };
  const set = (next: LinkState) => {
    state = next;
    listeners.forEach((listener) => listener());
  };
  const push = (keys: string[]) => pushes.forEach((listener) => listener({ type: "invalidate", keys }));
  return { link, cloud, asked, set, push };
}

it("asks the shown Mac whose cloud it is once per session, and again when the Mac says its account changed", async () => {
  const at = world();
  followMac(at.link, at.cloud, () => undefined);
  expect(at.cloud.follow).not.toHaveBeenCalled();
  at.set(connected(1));
  await vi.waitFor(() => expect(at.cloud.follow).toHaveBeenCalledTimes(1));
  expect(at.asked).toEqual(["cloud.session.owner"]);
  at.set(connected(1));
  at.push(["threads"]);
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(at.cloud.follow).toHaveBeenCalledTimes(1);
  at.push(["cloud.session"]);
  await vi.waitFor(() => expect(at.cloud.follow).toHaveBeenCalledTimes(2));
  at.set(connected(2));
  await vi.waitFor(() => expect(at.cloud.follow).toHaveBeenCalledTimes(3));
});

it("leaves the cloud as it is with a Mac too old to give one or in the demo, and lets it go with no Mac at all", async () => {
  const older = world([]);
  followMac(older.link, older.cloud, () => undefined);
  older.set(connected(1));
  older.push(["cloud.session"]);
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(older.cloud.follow).not.toHaveBeenCalled();
  expect(older.asked).toEqual([]);

  const demo = world();
  followMac(demo.link, demo.cloud, () => undefined);
  demo.set({ kind: "connected", mac: { id: "demo", name: "Demo" }, route: { kind: "demo" }, serial: 1 });
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(demo.cloud.follow).not.toHaveBeenCalled();

  const gone = world();
  followMac(gone.link, gone.cloud, () => undefined);
  gone.set({ kind: "unpaired", lost: null });
  expect(gone.cloud.release).toHaveBeenCalledTimes(1);
});

it("says once why a follow failed, and keeps listening", async () => {
  const at = world();
  const warned: string[] = [];
  at.cloud.follow.mockRejectedValueOnce(new Error("Sign in to OpenOrc Cloud on your Mac first."));
  followMac(at.link, at.cloud, (message) => void warned.push(message));
  at.set(connected(1));
  await vi.waitFor(() => expect(warned).toEqual(["The phone's cloud was not taken from its Mac: Sign in to OpenOrc Cloud on your Mac first."]));
  at.push(["cloud.session"]);
  await vi.waitFor(() => expect(at.cloud.follow).toHaveBeenCalledTimes(2));
});
