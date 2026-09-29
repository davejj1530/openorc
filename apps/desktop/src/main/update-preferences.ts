import { readFileSync, renameSync, writeFileSync } from "node:fs";

interface Preferences {
  automaticChecks?: boolean;
  dismissedVersion?: string | null;
  notifiedVersion?: string;
}

/** Whether OpenOrc checks for updates on its own, kept in a file of its own because main reads it before the core starts. */
export class UpdatePreferences {
  constructor(private readonly file: string) {}

  /** On unless turned off; a missing or unreadable file keeps the default. */
  automaticChecks(): boolean {
    return this.read().automaticChecks !== false;
  }

  dismissedVersion(): string | null {
    return this.read().dismissedVersion ?? null;
  }

  notifiedVersion(): string | undefined {
    return this.read().notifiedVersion;
  }

  private read(): Preferences {
    try {
      const value: unknown = JSON.parse(readFileSync(this.file, "utf8"));
      return value && typeof value === "object" ? (value as Preferences) : {};
    } catch {
      return {};
    }
  }

  setAutomaticChecks(on: boolean): void {
    this.save({ automaticChecks: on });
  }

  dismiss(version: string | null): void {
    this.save({ dismissedVersion: version });
  }

  markNotified(version: string): void {
    this.save({ notifiedVersion: version });
  }

  private save(patch: Preferences): void {
    writeFileSync(`${this.file}.tmp`, `${JSON.stringify({ ...this.read(), ...patch })}\n`);
    renameSync(`${this.file}.tmp`, this.file);
  }
}
