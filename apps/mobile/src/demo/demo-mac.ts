import { LinkCloseCode, type MacMessage, type PhoneMessage } from "@openorc/link";
import type { PhoneLine } from "../connection/link-connection";
import type { DemoMac, MacName } from "../connection/manager";
import type { Clock } from "../connection/route-race";
import { DemoCore } from "./core";

export const DEMO_MAC: MacName = { id: "demo", name: "Demo Mac" };

/** A message as the other end reads it off the wire: its own copy, never an object the sender keeps changing. */
const copied = <T>(message: T): T => JSON.parse(JSON.stringify(message)) as T;

/**
 * A line to a fresh demo Mac inside the app. Each side hears a copy of what the other sent, on a later turn, as over
 * the network, and nothing after the line closes; closing it stops the demo Mac and drops everything done to it.
 */
function demoLine(clock: Clock): PhoneLine {
  const messages = new Set<(message: MacMessage) => void>();
  const bytes = new Set<(stream: number, chunk: Uint8Array, end: boolean) => void>();
  const closes = new Set<(code: number, reason: string) => void>();
  let closed = false;
  const later = (deliver: () => void) => void Promise.resolve().then(() => closed || deliver());
  const core = new DemoCore(
    {
      message: (message) => {
        const sent = copied(message);
        later(() => messages.forEach((listener) => listener(sent)));
      },
      bytes: (stream, chunk) => later(() => bytes.forEach((listener) => listener(stream, chunk.slice(), true))),
    },
    clock,
  );
  const listen =
    <T>(set: Set<T>) =>
    (listener: T) => {
      set.add(listener);
      return () => set.delete(listener);
    };
  return {
    get closed() {
      return closed;
    },
    send: (message: PhoneMessage) => {
      const sent = copied(message);
      later(() => core.receive(sent));
    },
    onMessage: listen(messages),
    onBytes: listen(bytes),
    onClose: listen(closes),
    close: (code = LinkCloseCode.normal, reason = "") => {
      if (closed) return;
      closed = true;
      core.stop();
      closes.forEach((listener) => listener(code, reason));
    },
  };
}

/** The demo Mac the phone shows before it pairs: every line a fresh one. */
export function createDemoMac(clock: Clock): DemoMac {
  return { mac: DEMO_MAC, open: () => demoLine(clock) };
}
