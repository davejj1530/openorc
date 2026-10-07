import type { Broadcast, RpcReply } from "@openorc/core";
import { RpcRequest } from "@openorc/protocol";

/** The core's end of one window's channel, as the core uses it: MessagePortMain in the app. */
export interface WindowPort {
  on(event: "message", listener: (event: { data: unknown }) => void): unknown;
  on(event: "close", listener: () => void): unknown;
  postMessage(message: Broadcast | RpcReply): void;
}

/**
 * The windows connected to the core. A broadcast reaches every one of them. A reply reaches only the window whose
 * request it answers: each window counts request ids from 1, so a reply sent to all of them would also settle another
 * window's request that has the same id, and every result body would be copied to every window.
 */
export function windowPorts(answer: (request: RpcRequest) => Promise<RpcReply>) {
  let ports: WindowPort[] = [];
  return {
    broadcast(message: Broadcast): void {
      for (const port of ports) port.postMessage(message);
    },
    attach(port: WindowPort): void {
      ports.push(port);
      port.on("close", () => {
        ports = ports.filter((open) => open !== port);
      });
      port.on("message", (event) => {
        const parsed = RpcRequest.safeParse(event.data);
        if (!parsed.success) {
          console.warn(`[core] dropped malformed message: ${parsed.error.message}`);
          return;
        }
        // A window that closed while its request ran has nobody left to read the answer.
        void answer(parsed.data).then((reply) => {
          if (ports.includes(port)) port.postMessage(reply);
        });
      });
    },
  };
}
