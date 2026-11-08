import { settings, type Db } from "@openorc/db";
import { AppSettings, enabledHarnessIds, type HarnessId } from "@openorc/protocol";

const defaults: AppSettings = {
  notifications: true,
  sound: false,
  autoDoneDays: 3,
  autoDoneOnPrMerge: true,
  autoArchiveDoneDays: 14,
  defaultWorkspaceMode: "current",
  defaultPermissionMode: "autonomous",
  defaultHarness: null,
  enabledHarnesses: null,
  look: null,
  idleProcessMinutes: 10,
  claudeUserMcpServers: true,
  claudeConnectorsOff: [],
  claudeAccountAutoSwitch: false,
};

const KEY = "app.settings";

/** Preferences that are not about memory, stored as one JSON row and validated on the way out. */
export class AppSettingsService {
  constructor(private readonly db: Db) {}

  get(): AppSettings {
    const raw = settings.get(this.db, KEY);
    if (!raw) return defaults;
    try {
      return AppSettings.parse({ ...defaults, ...(JSON.parse(raw) as Partial<AppSettings>) });
    } catch {
      return defaults;
    }
  }

  set(patch: Partial<AppSettings>): AppSettings {
    const next = AppSettings.parse({ ...this.get(), ...patch });
    if (next.enabledHarnesses != null) {
      next.enabledHarnesses = [...enabledHarnessIds(next)];
      if (next.defaultHarness && !next.enabledHarnesses.includes(next.defaultHarness)) next.defaultHarness = next.enabledHarnesses[0] ?? null;
    }
    settings.set(this.db, KEY, JSON.stringify(next));
    return next;
  }

  enabledHarnesses(): readonly HarnessId[] {
    return enabledHarnessIds(this.get());
  }
}
