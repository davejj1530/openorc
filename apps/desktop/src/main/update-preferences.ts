import { readFileSync, renameSync, writeFileSync } from "node:fs";

/** Whether OpenOrc checks for updates on its own, kept in a file of its own because main reads it before the core starts. */
export class UpdatePreferences {
  constructor(private readonly file: string) {}

  /** On unless turned off; a missing or unreadable file keeps the default. */
  automaticChecks(): boolean {
    try {
      return (JSON.parse(readFileSync(this.file, "utf8")) as { automaticChecks?: unknown }).automaticChecks !== false;
    } catch {
      return true;
    }
  }

  setAutomaticChecks(on: boolean): void {
    writeFileSync(`${this.file}.tmp`, `${JSON.stringify({ automaticChecks: on })}\n`);
    renameSync(`${this.file}.tmp`, this.file);
  }
}
