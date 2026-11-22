import { claudeAccounts, type Db } from "@openorc/db";
import type { RunService } from "../services/runs.js";
import { AppSettingsService } from "../services/settings.js";
import { TextGenerationService } from "../services/text-generation.js";
import type { Handlers } from "./types.js";
type Dependencies = {
  settings: Pick<AppSettingsService, "get" | "set">;
  textGeneration: Pick<TextGenerationService, "settings" | "updateSettings">;
  invalidate: (keys: string[]) => void;
  /** Keeping Claude accounts separate or not changes what a Claude process starts with, so each account's idle ones close. */
  claudeSessions?: { db: Db; runs: Pick<RunService, "retireIdleClaudeSessions"> };
};

export function createSettingsHandlers({
  settings,
  textGeneration,
  invalidate,
  claudeSessions,
}: Dependencies): Pick<Handlers, "app.settings.get" | "app.settings.set" | "textGeneration.settings.get" | "textGeneration.settings.set"> {
  return {
    "app.settings.get": () => settings.get(),
    "app.settings.set": (patch) => {
      const before = settings.get().claudeAccountsSeparate;
      const next = settings.set(patch);
      if (next.claudeAccountsSeparate !== before && claudeSessions) retireIdleClaudeSessions(claudeSessions);
      invalidate(["settings", ...(patch.enabledHarnesses === undefined ? [] : ["models", "system", "agent-updates", "connectors", "text-generation", "provider-usage"])]);
      return next;
    },
    "textGeneration.settings.get": () => textGeneration.settings(),
    "textGeneration.settings.set": (patch) => textGeneration.updateSettings(patch),
  };
}

function retireIdleClaudeSessions({ db, runs }: NonNullable<Dependencies["claudeSessions"]>): void {
  for (const account of claudeAccounts.list(db)) void runs.retireIdleClaudeSessions(account.id).catch(() => undefined);
}
