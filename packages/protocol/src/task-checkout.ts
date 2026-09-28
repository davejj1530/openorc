/** A retained preview applies working files only; it never advances HEAD or stages files. */
export interface TaskCheckoutPreview {
  id: string;
  sourcePath: string;
  destinationPath: string;
  destinationBranch: string | null;
  state: "ready" | "conflict" | "attention" | "applied";
  patch: string;
  files: number;
  conflicts: string[];
  scratchPath: string;
  error: string | null;
}
export interface TaskCheckoutState {
  allowed: boolean;
  reason: string | null;
  preview: TaskCheckoutPreview | null;
}
