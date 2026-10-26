import { createClientState, type CoreConnection } from "@openorc/client";
import type { RpcMethod } from "@openorc/protocol";
import { QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import type { LinkState } from "../connection/manager";
import { ScratchStore } from "../scratch-store";

const connected: LinkState = { kind: "connected", mac: { id: "mac-1", name: "Studio" }, route: { kind: "lan", host: "studio.local", port: 1 }, serial: 1 };

/**
 * The phone's `../client` over a Mac a test answers, shown as `mac-1` connected over Wi-Fi: the real query cache,
 * mutations and permission default, every call (through the hooks or `link.connection`) going to `answer`, and a map
 * standing in for the phone's MMKV. `wrapper` gives rendered hooks the cache.
 */
export function fakeMac(answer: (method: RpcMethod, params: unknown) => Promise<unknown>) {
  const connection: CoreConnection = {
    delivery: "interest",
    call: ((method: RpcMethod, params: unknown) => answer(method, params)) as CoreConnection["call"],
    onPush: () => () => undefined,
    setFrameInterest: () => undefined,
  };
  const client = createClientState(connection, { scheduleFrame: () => undefined, invalidationBatchMs: 0, randomId: () => "id", savesDefaultPermission: false });
  const saved = new Map<string, string>();
  const storage = new ScratchStore({ getString: (key) => saved.get(key), set: (key, value) => void saved.set(key, value), remove: (key) => void saved.delete(key) });
  const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: client.queryClient }, children);
  return {
    saved,
    wrapper,
    module: {
      client,
      link: { connection, getState: () => connected, subscribe: () => () => undefined },
      queryClient: client.queryClient,
      storage,
      shownMacId: () => "mac-1",
      useLinkState: () => connected,
      useRpc: client.useRpc,
      useRpcs: client.useRpcs,
      useRpcMutation: client.useRpcMutation,
    },
  };
}

export type FakeMac = ReturnType<typeof fakeMac>;
