import { createClientState, type CoreConnection } from "@openorc/client";
import type { RpcMethod } from "@openorc/protocol";
import { QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";

/**
 * The phone's `../client` over a Mac a test answers: the real query cache, mutations and permission default, every
 * call (through the hooks or `link.connection`) going to `answer`, and a map standing in for the phone's MMKV.
 * `wrapper` gives rendered hooks the cache.
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
  const storage = { getString: (key: string) => saved.get(key), set: (key: string, value: string) => void saved.set(key, value), remove: (key: string) => saved.delete(key) };
  const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: client.queryClient }, children);
  return {
    saved,
    wrapper,
    module: {
      client,
      link: { connection },
      queryClient: client.queryClient,
      storage,
      shownMacId: () => "mac-1",
      useRpc: client.useRpc,
      useRpcs: client.useRpcs,
      useRpcMutation: client.useRpcMutation,
    },
  };
}

export type FakeMac = ReturnType<typeof fakeMac>;
