import { AppSettingsService } from "../services/settings.js";
import { TextGenerationService } from "../services/text-generation.js";
import type { Handlers } from "./types.js";
type Dependencies = {
  settings: Pick<AppSettingsService, "get" | "set">;
  textGeneration: Pick<TextGenerationService, "settings" | "updateSettings">;
  invalidate: (keys: string[]) => void;
};

export function createSettingsHandlers({
  settings,
  textGeneration,
  invalidate,
}: Dependencies): Pick<Handlers, "app.settings.get" | "app.settings.set" | "textGeneration.settings.get" | "textGeneration.settings.set"> {
  return {
    "app.settings.get": () => settings.get(),
    "app.settings.set": (patch) => {
      const next = settings.set(patch);
      invalidate(["settings", "orchestration"]);
      return next;
    },
    "textGeneration.settings.get": () => textGeneration.settings(),
    "textGeneration.settings.set": (patch) => textGeneration.updateSettings(patch),
  };
}
