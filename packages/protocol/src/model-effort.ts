/** Preserve the selected wire effort; the installed model catalog is authoritative. */
export function normalizeModelEffort<T extends string | null | undefined>(_agent: string, _model: string | null | undefined, effort: T): T {
  return effort;
}

/** Keep historical and future settings intact without rewriting saved snapshots. */
export function normalizeModelSettings<T extends { agent: string; model?: string | null | undefined; effort?: string | null | undefined }>(settings: T): T {
  return settings;
}

export function modelEfforts(_agent: string, _model: string, efforts: string[]): string[] {
  return efforts;
}

/**
 * Claude Code's `ultracode` is not a reasoning level of its own: it runs at
 * xhigh and tells the model to orchestrate dynamic workflows by default.
 */
export const ULTRACODE_EFFORT = "ultracode";

export function effortLabel(effort: string): string {
  return effort === "xhigh" ? "Extra high" : effort.charAt(0).toUpperCase() + effort.slice(1);
}

/** What a step means beyond its name; only the combined steps need one. */
export function effortHint(effort: string | null | undefined): string | null {
  return effort === ULTRACODE_EFFORT ? "Extra high + workflows" : null;
}
