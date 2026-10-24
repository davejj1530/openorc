import { vi } from "vitest";
import type { RpcMethod } from "@openorc/protocol";
import { createClientState } from "../client-state.js";
import type { ClientPush, CoreConnection } from "../connection.js";

/**
 * A core connection a test drives: `call` is a mock to answer, `push` delivers, and `wire` lists calls and interest
 * changes in the order they reached the core.
 */
export function fakeConnection(delivery: CoreConnection["delivery"] = "all") {
  const listeners = new Set<(push: ClientPush) => void>();
  const wire: string[] = [];
  const call = vi.fn<(method: RpcMethod, params: unknown) => Promise<unknown>>();
  const connection: CoreConnection = {
    delivery,
    call: ((method: RpcMethod, params: unknown) => {
      wire.push(`call ${method}`);
      return call(method, params);
    }) as CoreConnection["call"],
    onPush(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setFrameInterest(runIds) {
      wire.push(`interest ${[...runIds].sort().join(",")}`);
    },
  };
  const push = (message: ClientPush) => listeners.forEach((listener) => listener(message));
  return { connection, call, push, wire };
}

/** A client over a fake connection that publishes only when the test flushes or the store's timer fires. */
export function testClient(delivery: CoreConnection["delivery"] = "all") {
  const fake = fakeConnection(delivery);
  const client = createClientState(fake.connection, { scheduleFrame: () => undefined, invalidationBatchMs: 50, randomId: () => "request" });
  return { ...fake, client };
}
