/**
 * The account's live socket: socket.io on the websocket transport alone, as the server offers, with the token in the
 * handshake's `auth`. `io` is socket.io-client's, passed in by the host, so this package imports no client library; the
 * Mac's core and the phone each give their own.
 *
 * The client reconnects by itself after the network's errors. A refusal of the token stops it; a server that drops the
 * socket on purpose (a change of the spaces it may hear) is joined again at once; a closed socket never comes back.
 */
import { ACCOUNT_PROTOCOL_HEADER, ACCOUNT_PROTOCOL_VERSION } from "@openorc/protocol";
import type { LiveSocket } from "./index.js";

/** How long a socket the server answered with an error other than a refusal waits before trying again. */
const RETRY_MS = 10_000;
/** How long the server has to answer a message on the socket. */
const ASK_MS = 10_000;

/** What this uses of a socket.io client socket. */
export interface SocketIoSocket {
  readonly active: boolean;
  on(event: "connect", listener: () => void): unknown;
  on(event: "disconnect", listener: (reason: string) => void): unknown;
  on(event: "connect_error", listener: (error: Error) => void): unknown;
  on(event: string, listener: Parameters<LiveSocket["on"]>[1]): unknown;
  connect(): unknown;
  close(): unknown;
  timeout(ms: number): { emitWithAck(event: string, body: unknown): Promise<unknown> };
}

/** socket.io-client's `io`, as this calls it. */
export type SocketIo = (url: string, options: { transports: string[]; auth: { token: string }; extraHeaders: Record<string, string>; reconnectionDelayMax: number }) => SocketIoSocket;

export function liveSocketOf(io: SocketIo): (url: string, token: string) => LiveSocket {
  return (url, token) => {
    const socket = io(url, { transports: ["websocket"], auth: { token }, extraHeaders: { [ACCOUNT_PROTOCOL_HEADER]: String(ACCOUNT_PROTOCOL_VERSION) }, reconnectionDelayMax: 60_000 });
    let retry: ReturnType<typeof setTimeout> | null = null;
    let closed = false;
    const listeners: ((state: "up" | "down" | "refused") => void)[] = [];
    const emit = (state: "up" | "down" | "refused") => listeners.forEach((listener) => listener(state));
    const clearRetry = () => {
      if (retry) clearTimeout(retry);
      retry = null;
    };
    const reconnect = (delay: number) => {
      if (closed || retry || socket.active) return;
      retry = setTimeout(() => {
        retry = null;
        if (!closed) socket.connect();
      }, delay);
    };
    socket.on("connect", () => {
      clearRetry();
      emit("up");
    });
    socket.on("disconnect", (reason) => {
      emit("down");
      // Membership changes force a new handshake with the remaining spaces.
      if (reason === "io server disconnect") reconnect(0);
    });
    socket.on("connect_error", (error) => {
      if (error.message === "UNAUTHORIZED") {
        clearRetry();
        return emit("refused");
      }
      emit("down");
      // A refusal from the server's handshake stops the client's own retries; the network's errors do not.
      reconnect(RETRY_MS);
    });
    return {
      onState: (listener) => void listeners.push(listener),
      on: (event, listener) => void socket.on(event, listener),
      ask: (event, body) => socket.timeout(ASK_MS).emitWithAck(event, body),
      close: () => {
        closed = true;
        clearRetry();
        socket.close();
      },
    };
  };
}
