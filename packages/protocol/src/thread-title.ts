import { redact } from "./redact.js";

/** Mask the whole prompt before taking its first nonblank line, so a cut never exposes part of a secret. */
export function titleFromPrompt(prompt: string): string {
  const line =
    redact(prompt)
      .text.split("\n")
      .find((part) => part.trim())
      ?.trim() ?? "New thread";
  const points = [...line];
  return points.length <= 72 ? line : `${points.slice(0, 71).join("").trimEnd()}…`;
}
