import { AsyncLocalStorage } from "node:async_hooks";

/** Who asked, set by RemoteSession only and never on the wire. A window's request has no origin. */
export type RequestOrigin = { kind: "phone"; deviceId: string };

/** The origin of the request being handled, carried across every await of its handler. */
export const requestOrigin = new AsyncLocalStorage<RequestOrigin | undefined>();

/** Audit metadata naming the phone a request came from; nothing for a window's. */
export function phoneOrigin(): { via: "phone"; device: string } | Record<string, never> {
  const origin = requestOrigin.getStore();
  return origin?.kind === "phone" ? { via: "phone", device: origin.deviceId } : {};
}
