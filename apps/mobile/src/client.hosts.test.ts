import type { Route } from "@openorc/protocol";
import { expect, it, vi } from "vitest";
import type { FakeMac, memoryKeys, memoryMacs } from "./connection/test-fixtures/fake-mac";

/** A phone an earlier build paired with a Mac and the cloud brain it named, showing the brain last. */
const BRAIN = "BBBB";
const world = vi.hoisted(() => ({}) as { mac: FakeMac; saved: ReturnType<typeof memoryMacs>; keys: ReturnType<typeof memoryKeys>; doorKeys: Map<string, string>; offer: unknown });

vi.mock("expo-constants", () => ({ default: { deviceName: "Test iPhone" } }));
vi.mock("expo-network", () => ({
  NetworkStateType: { NONE: "NONE", UNKNOWN: "UNKNOWN", CELLULAR: "CELLULAR", WIFI: "WIFI", ETHERNET: "ETHERNET" },
  getNetworkStateAsync: () => new Promise(() => undefined),
  addNetworkStateListener: () => ({ remove: () => undefined }),
}));
vi.mock("react-native-mmkv", () => ({
  createMMKV: () => {
    const saved = new Map<string, string>();
    return { getString: (key: string) => saved.get(key), set: (key: string, value: string) => void saved.set(key, value), remove: (key: string) => saved.delete(key) };
  },
}));
vi.mock("react-native-quick-crypto", () => ({ randomUUID: () => "id" }));
vi.mock("./notifications/on-screen", () => ({ threadOnScreen: () => null }));
vi.mock("./connection/asset-cache", () => ({ createAssetCache: () => ({ forget: () => undefined, uri: async () => "" }) }));
vi.mock("./connection/native", async () => {
  const { toBase64Url } = await import("@openorc/link");
  const { nobleCrypto } = await import("@openorc/link/test-fixtures/noble-crypto");
  const fixtures = await import("./connection/test-fixtures/fake-mac");
  const mac = new fixtures.FakeMac();
  mac.routes = [fixtures.lan];
  mac.behave(fixtures.lan, { kind: "answer" });
  mac.behave(fixtures.publicRoute, { kind: "answer" });
  mac.answer = (method) => (method === "cloud.offer" ? world.offer : undefined);
  const device = nobleCrypto.generateKeyPair();
  mac.paired.add(toBase64Url(device.publicKey));
  const saved = fixtures.memoryMacs(
    [
      { id: mac.id, name: "Studio", routes: [fixtures.lan], lastRoute: null, kind: "mac", brain: BRAIN },
      { id: BRAIN, name: "Cloud", routes: [fixtures.publicRoute], lastRoute: null, kind: "brain" },
    ],
    BRAIN,
  );
  const keys = fixtures.memoryKeys();
  keys.stored.set(mac.id, device.privateKey);
  keys.stored.set(BRAIN, nobleCrypto.generateKeyPair().privateKey);
  const doorKeys = new Map([[BRAIN, "a door ticket"]]);
  Object.assign(world, { mac, saved, keys, doorKeys, offer: { offered: true, provider: "vercel", brain: { host: BRAIN, projects: [] } } });
  return {
    phoneCrypto: nobleCrypto,
    systemClock: {
      now: () => Date.now(),
      setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms),
      clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    },
    openSocket: (route: Route) => mac.openSocket(route),
    storedMacs: () => saved,
    keychainKeys: keys,
    forgetDoorKey: async (id: string) => void doorKeys.delete(id),
    reachesInternet: async () => true,
  };
});

const connected = async (serial?: number) => {
  const { link } = await import("./client");
  await vi.waitFor(() => expect(link.getState()).toMatchObject({ kind: "connected", mac: { id: world.mac.id }, ...(serial ? { serial } : {}) }), { timeout: 5_000 });
  return link;
};

it("shows the Mac alone, and never dials the brain shown last, while an older Mac still has its brain", async () => {
  const link = await connected();
  await vi.waitFor(() => expect(world.mac.heard.some((message) => message.t === "rpc" && message.method === "cloud.offer")).toBe(true));
  expect(link.getMacs().map((host) => host.name)).toEqual(["Studio"]);
  expect(world.mac.dials.map((dial) => dial.host)).toEqual(["studio.local"]);
  // Out of sight, and kept until the Mac says it is gone.
  expect(world.saved.saved.has(BRAIN)).toBe(true);
  expect(world.saved.saved.get(world.mac.id)?.brain).toBe(BRAIN);
  expect(world.keys.stored.has(BRAIN)).toBe(true);
});

it("forgets the brain, this phone's key for it and its door key once the Mac says it removed it", async () => {
  const link = await connected();
  const { serial } = link.getState() as { serial: number };
  world.offer = { offered: false, provider: null };
  world.mac.removedBrains = [BRAIN];
  world.mac.closeAll("shutdown");
  await connected(serial + 1);
  await vi.waitFor(() => expect(world.doorKeys.has(BRAIN)).toBe(false));
  expect(world.saved.saved.has(BRAIN)).toBe(false);
  expect(world.keys.stored.has(BRAIN)).toBe(false);
  await vi.waitFor(() => expect(world.saved.saved.get(world.mac.id)?.brain).toBeNull());
  expect(link.getMacs().map((host) => host.name)).toEqual(["Studio"]);
  expect(link.getState()).toMatchObject({ kind: "connected", mac: { id: world.mac.id } });
  expect(world.mac.dials.every((dial) => dial.host === "studio.local")).toBe(true);
});
