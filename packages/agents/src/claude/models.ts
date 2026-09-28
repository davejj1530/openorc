import type { AgentLaunchEnvironment } from "../launch-environment.js";
import { withClaudeControlSession } from "./control-session.js";

export interface ClaudeModel {
  value: string;
  resolvedModel?: string;
  displayName: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: string[];
  supportsFastMode?: boolean;
}

export interface ClaudeCatalog {
  models: ClaudeModel[];
  /** Claude Code's code for why this account cannot use Fast right now; absent when nothing blocks it. */
  fastModeDisabledReason?: string;
}

/** The same initialize response used by the SDK's supportedModels(), without an SDK or a user turn. It also carries the account's Fast access. */
export function listClaudeModels(launch: AgentLaunchEnvironment, timeoutMs = 15_000): Promise<ClaudeCatalog> {
  // Asking for Fast is what makes the CLI check this account's Fast access; nothing runs.
  return withClaudeControlSession(launch, { task: "listing models", settings: { fastMode: true }, timeoutMs }, async (ask) => {
    const response = await ask({ subtype: "initialize", hooks: {} });
    if (!Array.isArray(response["models"])) throw new Error("Claude did not return a model catalog");
    const rows: ClaudeModel[] = [];
    for (const row of response["models"]) {
      if (!row || typeof row.value !== "string" || !row.value || typeof row.displayName !== "string") continue;
      rows.push({
        value: row.value,
        displayName: row.displayName,
        ...(typeof row.resolvedModel === "string" ? { resolvedModel: row.resolvedModel } : {}),
        ...(typeof row.supportsEffort === "boolean" ? { supportsEffort: row.supportsEffort } : {}),
        ...(Array.isArray(row.supportedEffortLevels) ? { supportedEffortLevels: row.supportedEffortLevels.filter((v: unknown): v is string => typeof v === "string") } : {}),
        ...(typeof row.supportsFastMode === "boolean" ? { supportsFastMode: row.supportsFastMode } : {}),
      });
    }
    if (!rows.length) throw new Error("Claude returned no models");
    const fastModeDisabledReason = response["fast_mode_disabled_reason"];
    return { models: rows, ...(typeof fastModeDisabledReason === "string" ? { fastModeDisabledReason } : {}) };
  });
}
