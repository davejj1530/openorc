import type { RpcMethod, RpcParams, RpcResults } from "@openorc/protocol";
import type { OpenOrc } from "./openorc.js";

/**
 * Calls the core the way a window does, for tests: through `handle`, with validation and error handling, resolving to
 * the method's result or rejecting with the error's message. `core` is read on every call, so a client made once at
 * module level follows a core the test recreates in `beforeEach`.
 */
export function rpcClient(core: () => OpenOrc) {
  let nextId = 0;
  return async <M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<RpcResults[M]> => {
    const reply = await core().handle({ type: "rpc", id: ++nextId, method, params });
    if (reply.type === "rpc.error") throw new Error(reply.message);
    return reply.result as RpcResults[M];
  };
}
