import { createClientState, type CoreConnection } from "@openorc/client";
import type { RpcMethod } from "@openorc/protocol";
import { QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import type { LinkState } from "../connection/manager";
import { ScratchStore } from "../scratch-store";

const connected: LinkState = { kind: "connected", mac: { id: "mac-1", name: "Studio" }, route: { kind: "lan", host: "studio.local", port: 1 }, serial: 1 };

/**
 * The phone's `../client` over a Mac a test answers, shown as `mac-1` connected over Wi-Fi: the real query cache,
 * mutations and permission default, every call (through the hooks or the link's `connection`) going to `answer`, and a map
 * standing in for the phone's MMKV. `wrapper` gives rendered hooks the cache.
 */
export function fakeMac(answer: (method: RpcMethod, params: unknown) => Promise<unknown>) {
  /** What this Mac shares besides its own threads; none, as an older Mac, until a test adds one. */
  const shared = new Set<string>();
  const connection: CoreConnection & { shares(capability: string): Promise<boolean> } = {
    delivery: "interest",
    call: ((method: RpcMethod, params: unknown) => answer(method, params)) as CoreConnection["call"],
    onPush: () => () => undefined,
    setFrameInterest: () => undefined,
    shares: async (capability) => shared.has(capability),
  };
  const client = createClientState(connection, {
    scheduleFrame: () => undefined,
    invalidationBatchMs: 0,
    randomId: () => "id",
    savesDefaultPermission: false,
    reportFrameError: (_frame, error) => {
      throw error;
    },
  });
  const saved = new Map<string, string>();
  const storage = new ScratchStore({ getString: (key) => saved.get(key), set: (key, value) => void saved.set(key, value), remove: (key) => void saved.delete(key) });
  const link = { connection, getState: () => connected, subscribe: () => () => undefined, retry: async () => undefined };
  const cloudListeners = new Set<() => void>();
  const cloud = {
    holds: false,
    subscribe: (listener: () => void) => {
      cloudListeners.add(listener);
      return () => void cloudListeners.delete(listener);
    },
    /** The phone comes to hold a session of its own, or lets it go. */
    hold(held: boolean) {
      cloud.holds = held;
      cloudListeners.forEach((listener) => listener());
    },
  };
  const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: client.queryClient }, children);
  return {
    saved,
    shared,
    wrapper,
    /** The phone's own cloud as the client sees it: none until a test holds one. */
    cloud,
    module: {
      client,
      link,
      cloud,
      queryClient: client.queryClient,
      storage,
      shownMacId: () => "mac-1",
      useLinkState: () => connected,
      useSession: () => 1,
      useSavedMacs: () => [],
      useRpc: client.useRpc,
      useRpcs: client.useRpcs,
      useRpcMutation: client.useRpcMutation,
      newId: () => crypto.randomUUID(),
      call: connection.call,
    },
  };
}

export type FakeMac = ReturnType<typeof fakeMac>;
