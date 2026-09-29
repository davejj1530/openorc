export type UpdateState =
  | { phase: "disabled"; reason: string }
  | { phase: "idle" | "checking" | "current" }
  | { phase: "available" | "downloading" | "ready"; version: string; percent?: number; error?: string; checkError?: string }
  | { phase: "installing"; version: string }
  | { phase: "error"; message: string }
  | { phase: "install-error"; message: string };

export interface UpdateSnapshot {
  state: UpdateState;
  dismissed: boolean;
}

/** Capture the user's intent and the notice they acted on before crossing the window channel. */
export type UpdateDismissal = { kind: "later"; phase: "available" | "ready"; version: string } | { kind: "hide"; phase: "downloading"; version: string } | { kind: "hide"; phase: "install-error" };

export function isUpdateDismissal(value: unknown): value is UpdateDismissal {
  if (!value || typeof value !== "object") return false;
  const request = value as Partial<UpdateDismissal>;
  if (request.kind === "hide" && request.phase === "install-error") return true;
  if (!("version" in request) || typeof request.version !== "string" || !request.version || request.version.length > 256) return false;
  if (request.kind === "later") return request.phase === "available" || request.phase === "ready";
  return request.kind === "hide" && request.phase === "downloading";
}
