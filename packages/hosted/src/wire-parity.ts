import { HostedCapabilities } from "@openorc/protocol";
import type { Route } from "./wire.js";
import { ROUTES, wireThreadDetail } from "./wire.js";

export const PARITY_ROUTES = {
  capabilities: { method: "GET", path: "/hosted/capabilities", reply: HostedCapabilities } satisfies Route<HostedCapabilities>,
  readableThread: (id: string) => ({ ...ROUTES.thread(id), reply: wireThreadDetail.passthrough() }),
};
