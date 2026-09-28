import { settings, type Db } from "@openorc/db";
import { AppSettings } from "@openorc/protocol";

const defaults: AppSettings = {
  experimentalTeamExecution: true,
  notifications: true,
  sound: false,
  autoDoneDays: 3,
  autoDoneOnPrMerge: true,
  autoArchiveDoneDays: 14,
  defaultWorkspaceMode: "current",
  defaultPermissionMode: "trusted",
  idleProcessMinutes: 10,
  claudeUserMcpServers: true,
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
    settings.set(this.db, KEY, JSON.stringify(next));
    return next;
  }
}
