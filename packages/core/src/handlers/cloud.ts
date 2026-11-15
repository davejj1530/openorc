import { rpcParams, type RpcMethod } from "@openorc/protocol";
import type { Handlers } from "./types.js";

/** The methods of the person's own cloud, which this app no longer has. They answer a refusal until the protocol drops them. */
type Removed = Exclude<Extract<RpcMethod, `cloud.${string}` | `brain.${string}` | "threads.snapshot">, "cloud.offer">;

const isRemoved = (method: string): method is Removed => method !== "cloud.offer" && (method.startsWith("cloud.") || method.startsWith("brain.") || method === "threads.snapshot");

const GONE = "This app no longer runs threads in your own cloud.";

/**
 * What is left of the person's own cloud: the one answer phones in the field still ask a Mac for. A build from before
 * the removal that hears `offered: false` with no brain offers no cloud place and forgets the brain it saved for this Mac.
 */
export function createCloudHandlers(): Pick<Handlers, "cloud.offer" | Removed> {
  const refuse = (): never => {
    throw new Error(GONE);
  };
  const removed = Object.fromEntries(
    Object.keys(rpcParams)
      .filter(isRemoved)
      .map((method) => [method, refuse]),
  ) as unknown as Pick<Handlers, Removed>;
  return { ...removed, "cloud.offer": () => ({ offered: false, provider: null }) };
}
