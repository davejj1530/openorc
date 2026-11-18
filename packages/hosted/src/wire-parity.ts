import { HostedCapabilities } from "@openorc/protocol";
import type { Route } from "./wire.js";
import { ROUTES, wireThreadDetail } from "./wire.js";

export const PARITY_ROUTES = {
  capabilities: { method: "GET", path: "/hosted/capabilities", reply: HostedCapabilities } satisfies Route<HostedCapabilities>,
  /** As `capabilities`, answered for one thread: a family with all the subthreads it takes holds New subthread. A server that reads no `threadId` answers for the space. */
  threadCapabilities: (threadId: string): Route<HostedCapabilities> => ({ method: "GET", path: `/hosted/capabilities?threadId=${encodeURIComponent(threadId)}`, reply: HostedCapabilities }),
  readableThread: (id: string) => ({ ...ROUTES.thread(id), reply: wireThreadDetail.passthrough() }),
};
