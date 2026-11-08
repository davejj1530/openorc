import type { ModelChoice } from "@openorc/client";
import { shownMacId, storage } from "../client";

const KEPT = 12;
const keyOf = () => `models.recent.${shownMacId() ?? "none"}`;

/** Models picked on this phone for the shown Mac, newest first, as `agent:id`. */
export function recentModels(): string[] {
  try {
    const saved: unknown = JSON.parse(storage.getString(keyOf()) ?? "[]");
    return Array.isArray(saved) ? saved.filter((each): each is string => typeof each === "string") : [];
  } catch {
    return [];
  }
}

/** Remembers a pick, so the Model sheet offers it first next time. */
export function rememberModel(choice: Pick<ModelChoice, "agent" | "model">): void {
  const picked = `${choice.agent}:${choice.model}`;
  storage.set(keyOf(), JSON.stringify([picked, ...recentModels().filter((each) => each !== picked)].slice(0, KEPT)));
}
