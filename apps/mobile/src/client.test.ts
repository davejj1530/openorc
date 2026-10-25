import { expect, it, vi } from "vitest";
import { memoryKeys, memoryMacs } from "./connection/test-fixtures/fake-mac";

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
// No Mac paired: the link starts unpaired and dials nothing.
vi.mock("./connection/native", () => ({
  phoneCrypto: { sha256: () => new Uint8Array(32) },
  systemClock: { now: () => Date.now(), setTimeout: () => null, clearTimeout: () => undefined },
  openSocket: () => ({ opened: new Promise(() => undefined), close: () => undefined }),
  storedMacs: () => memoryMacs(),
  keychainKeys: memoryKeys(),
  reachesInternet: async () => true,
}));

it("follows the shown Mac's look from the moment the app loads", async () => {
  const { queryClient } = await import("./client");
  const { currentLook } = await import("./look/look");
  expect(currentLook().preset).toBe("openorc");
  queryClient.setQueryData(["app.settings.get", {}], { look: { palette: "claude", colors: {} } });
  expect(currentLook().preset).toBe("claude");
});
