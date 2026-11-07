import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import path from "node:path";
import { redact } from "@openorc/db";
import type { Transport } from "@openorc/core";

export type LogLevel = "info" | "warn" | "error";

/**
 * The brain's own log: every line passes through redact() first, and the file and the one before it stay under
 * `maxBytes` each. The start line and handed-over values never come here.
 */
export class BrainLog {
  private size: number | null = null;

  constructor(
    private readonly file: string,
    private readonly maxBytes = 5 * 1024 * 1024,
  ) {}

  write(level: LogLevel, text: string): void {
    const line = `${new Date().toISOString()} ${level} ${redact(text).text}\n`;
    try {
      this.size ??= this.measure();
      if (this.size > 0 && this.size + Buffer.byteLength(line) > this.maxBytes) {
        renameSync(this.file, `${this.file}.1`);
        this.size = 0;
      }
      appendFileSync(this.file, line, { mode: 0o600 });
      this.size += Buffer.byteLength(line);
    } catch {
      // A log that cannot be written must not take the brain down with it.
    }
  }

  /** The core's pushes as lines: its log and its startup notices. Everything else is for windows, and there are none. */
  transport(): Transport {
    return {
      push: (message) => {
        if (message.type === "log") this.write(message.level, message.message);
        else if (message.type === "startup") this.write("info", message.message);
      },
    };
  }

  private measure(): number {
    mkdirSync(path.dirname(this.file), { recursive: true });
    try {
      return statSync(this.file).size;
    } catch {
      return 0;
    }
  }
}
