import type { CorePush } from "@openorc/protocol";

/** The answer to one request. It goes back only to the window that sent it, on that window's own port. */
export type RpcReply = Extract<CorePush, { type: "rpc.result" | "rpc.error" }>;

/** What every window hears: frames, invalidations, notices, logs and startup state. Never a reply. */
export type Broadcast = Exclude<CorePush, RpcReply>;

/** How the core reaches the renderers. The Electron shell implements it over MessagePorts. */
export interface Transport {
  push(message: Broadcast): void;
}

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export function transportLogger(transport: Transport): Logger {
  const emit = (level: "info" | "warn" | "error", message: string) => {
    console.log(`[core:${level}] ${message}`);
    transport.push({ type: "log", level, message });
  };
  return {
    info: (m) => emit("info", m),
    warn: (m) => emit("warn", m),
    error: (m) => emit("error", m),
  };
}
