import { AppSettingsService } from "../services/settings.js";
import { TextGenerationService } from "../services/text-generation.js";
import type { Handlers } from "./types.js";
type Dependencies = {
  settings: Pick<AppSettingsService, "get" | "set">;
  textGeneration: Pick<TextGenerationService, "settings" | "updateSettings">;
  invalidate: (keys: string[]) => void;
  /** Keeping Claude accounts separate or not changes what a Claude process starts with, so the idle ones close. */
  accountsSeparateChanged?: () => void;
};

export function createSettingsHandlers({
  settings,
  textGeneration,
  invalidate,
  accountsSeparateChanged,
}: Dependencies): Pick<Handlers, "app.settings.get" | "app.settings.set" | "textGeneration.settings.get" | "textGeneration.settings.set"> {
  return {
    "app.settings.get": () => settings.get(),
    "app.settings.set": (patch) => {
      const before = settings.get().claudeAccountsSeparate;
      const next = settings.set(patch);
      if (next.claudeAccountsSeparate !== before) accountsSeparateChanged?.();
      invalidate(["settings", ...(patch.enabledHarnesses === undefined ? [] : ["models", "system", "agent-updates", "connectors", "text-generation", "provider-usage"])]);
      return next;
    },
    "textGeneration.settings.get": () => textGeneration.settings(),
    "textGeneration.settings.set": (patch) => textGeneration.updateSettings(patch),
  };
}
