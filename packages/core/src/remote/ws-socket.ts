import { LinkCloseCode, type LinkSocket } from "@openorc/link";
import type { WebSocket } from "ws";

/** `ws` waits 30 s for the other end to answer a close; one that never does should not hold its connection that long. */
const CLOSE_ANSWER_MS = 2_000;

/** A `ws` socket as a link session uses it: binary messages only, one listener each for messages and close. */
export function linkSocket(ws: WebSocket): LinkSocket {
  let onMessage: (data: Uint8Array) => void = () => {};
  let onClose: (code: number, reason: string) => void = () => {};
  ws.binaryType = "nodebuffer";
  ws.on("message", (data: Buffer, isBinary) => {
    if (isBinary) onMessage(data);
    else ws.close(LinkCloseCode.protocol, "binary messages only");
  });
  ws.on("close", (code, reason) => onClose(code, reason.toString()));
  ws.on("error", () => ws.terminate());
  return {
    send: (data) => {
      if (ws.readyState === ws.OPEN) ws.send(data);
    },
    bufferedAmount: () => ws.bufferedAmount,
    close: (code, reason) => {
      ws.close(code, reason.slice(0, 120));
      setTimeout(() => ws.terminate(), CLOSE_ANSWER_MS).unref();
    },
    onMessage: (listener) => {
      onMessage = listener;
    },
    onClose: (listener) => {
      onClose = listener;
    },
  };
}
