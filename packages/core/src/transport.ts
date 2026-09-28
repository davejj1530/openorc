import type { CorePush } from "@openorc/protocol";

/** How the core reaches the renderer. The Electron shell implements it over MessagePorts. */
export interface Transport {
  push(message: CorePush): void;
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
