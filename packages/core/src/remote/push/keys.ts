import { settings, type Db } from "@openorc/db";
import { PHONE_APP, type PushEnvironment } from "@openorc/protocol";
import type { ProtectedSecretStore } from "../../services/extraction-credentials.js";
import type { Logger } from "../../transport.js";
import { ApnsRoute, apnsSigningKey } from "./apns.js";
import type { PushRoute } from "./route.js";

/** The key id, which is not secret. The key itself lives only in protected storage. */
const SETTING = "remote.push";

export interface PushKeysOptions {
  db: Db;
  /** Keeps the push key's PEM. Without it, no key can be added. */
  secrets: ProtectedSecretStore | undefined;
  log: Logger;
  /** Where APNs answers; tests pass a fake. */
  origins?: Record<PushEnvironment, string>;
}

/** The Mac's Apple push key, and the route built from it on first use. Changing or removing the key closes the route. */
export class PushKeys {
  private route: PushRoute | null = null;
  /** Bumped by every key change, so a route built from the old key is never kept. */
  private generation = 0;

  constructor(private readonly options: PushKeysOptions) {}

  keyId(): string | null {
    try {
      const value = JSON.parse(settings.get(this.options.db, SETTING) ?? "null") as { keyId?: unknown } | null;
      return typeof value?.keyId === "string" ? value.keyId : null;
    } catch {
      return null;
    }
  }

  /** The route for the saved key, or null before one is added. */
  async current(): Promise<PushRoute | null> {
    if (this.route) return this.route;
    const generation = this.generation;
    const route = await this.build();
    if (!route || generation !== this.generation) {
      route?.close();
      return null;
    }
    this.route = route;
    return route;
  }

  async set(keyId: string, pem: string): Promise<void> {
    apnsSigningKey(pem);
    if (!this.options.secrets) throw new Error("Notifications need protected storage for the push key, which is not available.");
    await this.options.secrets.save(pem);
    settings.set(this.options.db, SETTING, JSON.stringify({ keyId }));
    this.close();
  }

  /** Overwrites the saved key with an empty one, as the reviewer app does. */
  async remove(): Promise<void> {
    await this.options.secrets?.save("");
    settings.remove(this.options.db, SETTING);
    this.close();
  }

  close(): void {
    this.generation += 1;
    this.route?.close();
    this.route = null;
  }

  private async build(): Promise<PushRoute | null> {
    const keyId = this.keyId();
    if (!keyId || !this.options.secrets) return null;
    try {
      const pem = await this.options.secrets.load();
      if (!pem) return null;
      return new ApnsRoute({ key: { keyId, teamId: PHONE_APP.teamId, pem }, topic: PHONE_APP.bundleId, ...(this.options.origins ? { origins: this.options.origins } : {}) });
    } catch (error) {
      this.options.log.warn(`The push key could not be loaded: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }
}
