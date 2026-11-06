// @vitest-environment jsdom
import { useQueryClient } from "@tanstack/react-query";
import { render, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { expect, it, vi } from "vitest";
import { HostContext } from "./connection/host-context";
import { memoryKeys, memoryMacs } from "./connection/test-fixtures/fake-mac";

/** The shown Mac, paired beside the cloud brain it named. */
const hosts = vi.hoisted(() => ({
  mac: { id: "AAAA", name: "Studio", routes: [{ kind: "lan", host: "studio.local", port: 1 }], lastRoute: null, kind: "mac", brain: "BBBB" },
  brain: { id: "BBBB", name: "Cloud", routes: [{ kind: "public", host: "sb-brain.vercel.run", port: 443 }], lastRoute: null, kind: "brain" },
  dialed: [] as string[],
  keyReads: [] as string[],
}));

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
vi.mock("./connection/native", () => {
  const keys = memoryKeys();
  for (const id of [hosts.mac.id, hosts.brain.id]) keys.stored.set(id, new Uint8Array(32));
  return {
    phoneCrypto: { sha256: () => new Uint8Array(32), keyPairFromPrivate: (key: Uint8Array) => ({ publicKey: key, privateKey: key }) },
    systemClock: { now: () => Date.now(), setTimeout: () => null, clearTimeout: () => undefined },
    openSocket: (route: { host: string }) => {
      hosts.dialed.push(route.host);
      return { opened: new Promise(() => undefined), close: () => undefined };
    },
    storedMacs: () => memoryMacs([hosts.mac, hosts.brain] as never, hosts.mac.id),
    keychainKeys: { ...keys, read: (id: string) => (hosts.keyReads.push(id), keys.read(id)) },
    keychainDoorKeys: { read: async () => null, write: async () => undefined, remove: async () => undefined },
    postKnock: () => new Promise(() => undefined),
    reachesInternet: async () => true,
    callAddress: async () => null,
  };
});

it("scopes a cloud thread's screens to the brain beside the shown Mac: its link state, its client and its connection", async () => {
  const phone = await import("./client");
  expect(phone.partnerHost()).toBe(hosts.brain.id);
  const read = () => ({ state: phone.useLinkState(), client: phone.useHostClient() });
  const onBrain = ({ children }: { children: ReactNode }) => <HostContext.Provider value={hosts.brain.id}>{children}</HostContext.Provider>;
  const brain = renderHook(read, { wrapper: onBrain }).result.current;
  const shown = renderHook(read).result.current;
  expect(brain.client).not.toBe(shown.client);
  expect(brain.client).toBe(phone.hostClient(hosts.brain.id));
  expect(brain.state).toBe(phone.partnerLink.getState());
  expect(shown.state).toBe(phone.link.getState());
  expect(phone.hostLink(hosts.brain.id)).toBe(phone.partnerLink);
  expect(phone.hostLink(hosts.mac.id)).toBe(phone.link);
  expect(phone.hostLink(null)).toBe(phone.link);
});

it("starts one race to the partner on a cold start, beside the shown Mac", async () => {
  await import("./client");
  await vi.waitFor(() => expect(hosts.dialed).toContain("sb-brain.vercel.run"));
  expect(hosts.keyReads.filter((id) => id === hosts.brain.id)).toHaveLength(1);
  expect(hosts.dialed.filter((host) => host === "sb-brain.vercel.run")).toHaveLength(1);
  expect(hosts.dialed.filter((host) => host === "studio.local")).toHaveLength(1);
});

it("keeps a header part, which the navigator draws outside the screen, on the screen's host", async () => {
  const phone = await import("./client");
  const { useHeaderScope } = await import("./connection/HostScope");
  const onBrain = ({ children }: { children: ReactNode }) => <HostContext.Provider value={hosts.brain.id}>{children}</HostContext.Provider>;
  const inScope = renderHook(useHeaderScope, { wrapper: onBrain }).result.current;
  function Line() {
    const link = phone.useLinkState() === phone.partnerLink.getState() ? "the brain's link" : "the shown Mac's link";
    const cache = useQueryClient() === phone.hostClient(hosts.brain.id).queryClient ? "the brain's cache" : "another cache";
    return <>{`${link}, ${cache}`}</>;
  }
  expect(render(inScope(<Line />)).container.textContent).toBe("the brain's link, the brain's cache");
});
