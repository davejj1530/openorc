import type { Route } from "@openorc/protocol";
import { expect, it, vi } from "vitest";
import type { SavedMac } from "./connection/saved-macs";
import type { FakeMac, memoryKeys, memoryMacs } from "./connection/test-fixtures/fake-mac";

/** A phone an earlier build paired with a Mac and the cloud brain it named, showing the brain last. */
type Earlier = SavedMac & { kind?: string; brain?: string | null };
const BRAIN = "BBBB";
const world = vi.hoisted(() => ({}) as { mac: FakeMac; saved: ReturnType<typeof memoryMacs>; keys: ReturnType<typeof memoryKeys>; doorKeys: Map<string, string> });

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
vi.mock("./cloud/native", () => ({
  keychainVault: { load: async () => null, save: async () => undefined },
  keptIn: () => ({ load: () => null, save: () => undefined, forget: () => undefined }),
  cloudKeys: { load: async () => null, save: async () => undefined, file: async () => undefined, unfile: async () => undefined },
}));
vi.mock("react-native-quick-crypto", () => ({ randomUUID: () => "id" }));
vi.mock("./notifications/on-screen", () => ({ threadOnScreen: () => null, knowCloudSender: () => undefined }));
vi.mock("./connection/asset-cache", () => ({ createAssetCache: () => ({ forget: () => undefined, uri: async () => "" }) }));
vi.mock("./connection/native", async () => {
  const { toBase64Url } = await import("@openorc/link");
  const { nobleCrypto } = await import("@openorc/link/test-fixtures/noble-crypto");
  const fixtures = await import("./connection/test-fixtures/fake-mac");
  const mac = new fixtures.FakeMac();
  mac.routes = [fixtures.lan];
  mac.behave(fixtures.lan, { kind: "answer" });
  mac.behave(fixtures.publicRoute, { kind: "answer" });
  const device = nobleCrypto.generateKeyPair();
  mac.paired.add(toBase64Url(device.publicKey));
  const saved = fixtures.memoryMacs(
    [
      { id: mac.id, name: "Studio", routes: [fixtures.lan], lastRoute: null, kind: "mac", brain: BRAIN },
      { id: BRAIN, name: "Cloud", routes: [fixtures.publicRoute], lastRoute: null, kind: "brain" },
    ] as Earlier[],
    BRAIN,
  );
  const keys = fixtures.memoryKeys();
  keys.stored.set(mac.id, device.privateKey);
  keys.stored.set(BRAIN, nobleCrypto.generateKeyPair().privateKey);
  const doorKeys = new Map([[BRAIN, "a door ticket"]]);
  Object.assign(world, { mac, saved, keys, doorKeys });
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

const connected = async () => {
  const { link } = await import("./client");
  await vi.waitFor(() => expect(link.getState()).toMatchObject({ kind: "connected", mac: { id: world.mac.id } }), { timeout: 5_000 });
  return link;
};

it("drops the brain an earlier build saved, with this phone's keys for it, and shows the Mac that named it", async () => {
  const link = await connected();
  expect(link.getMacs().map((host) => host.name)).toEqual(["Studio"]);
  expect(world.mac.dials.map((dial) => dial.host)).toEqual(["studio.local"]);
  expect([...world.saved.saved.keys()]).toEqual([world.mac.id]);
  expect(world.saved.saved.get(world.mac.id)).toEqual({ id: world.mac.id, name: "Studio", routes: [expect.objectContaining({ kind: "lan" })], lastRoute: expect.anything() });
  await vi.waitFor(() => expect(world.doorKeys.has(BRAIN)).toBe(false));
  expect(world.keys.stored.has(BRAIN)).toBe(false);
  expect(world.keys.stored.has(world.mac.id)).toBe(true);
});

it("asks the Mac nothing about a brain or a cloud offer", async () => {
  await connected();
  const asked = world.mac.heard.flatMap((message) => (message.t === "rpc" ? [message.method] : []));
  expect(asked).not.toContain("brains.removed");
  expect(asked).not.toContain("cloud.offer");
});
