export type UpdateState =
  | { phase: "disabled"; reason: string }
  | { phase: "idle" | "checking" | "current" }
  | { phase: "available" | "downloading" | "ready"; version: string; percent?: number; error?: string }
  | { phase: "installing"; version: string }
  | { phase: "error"; message: string }
  | { phase: "install-error"; message: string };

export interface UpdateSnapshot {
  state: UpdateState;
  dismissed: boolean;
}
