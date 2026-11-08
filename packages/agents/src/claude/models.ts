import { setTimeout as delay } from "node:timers/promises";
import type { AgentLaunchEnvironment } from "../launch-environment.js";
import { withClaudeControlSession, type ClaudeControlAsk } from "./control-session.js";

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

/** How long Fast access may stay unsettled after the first answer; Claude Code's account check lands in about a second. */
const FAST_SETTLE_MS = 2_000;
const FAST_RECHECK_MS = 250;

/** The same initialize response used by the SDK's supportedModels(), without an SDK or a user turn. It also carries the account's Fast access. */
export function listClaudeModels(launch: AgentLaunchEnvironment, timeoutMs = 15_000, fastSettleMs = FAST_SETTLE_MS): Promise<ClaudeCatalog> {
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
    const fastModeDisabledReason = rows.some((row) => row.supportsFastMode) ? await settledFastReason(ask, response, fastSettleMs) : fastReason(response);
    return { models: rows, ...(fastModeDisabledReason ? { fastModeDisabledReason } : {}) };
  });
}

function fastReason(answer: Record<string, unknown>): string | undefined {
  const reason = answer["fast_mode_disabled_reason"];
  return typeof reason === "string" ? reason : undefined;
}

/**
 * Claude Code answers before its account check lands. Until then a session that asked for Fast reads "on" (older
 * versions say `pending`), and asking again in the same session returns the settled answer.
 */
async function settledFastReason(ask: ClaudeControlAsk, first: Record<string, unknown>, settleMs: number): Promise<string | undefined> {
  const unsettled = (answer: Record<string, unknown>) => (answer["fast_mode_state"] === "on" && !fastReason(answer)) || fastReason(answer) === "pending";
  const deadline = Date.now() + settleMs;
  let answer = first;
  while (unsettled(answer) && Date.now() < deadline) {
    await delay(FAST_RECHECK_MS);
    answer = await ask({ subtype: "initialize", hooks: {} });
  }
  return fastReason(answer);
}
