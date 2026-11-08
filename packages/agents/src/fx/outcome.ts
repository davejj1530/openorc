import { z } from "zod";
import type { RunStatus } from "@openorc/protocol";

const providerError = z.object({ error: z.object({ message: z.string().min(1) }) });

/** fx uses different terminal names and presents HTTP provider failures as a refused assistant message. */
export function fxPromptOutcome(reason: string, text: string): { status: RunStatus; error?: Error } | undefined {
  switch (reason) {
    case "refused": {
      const error = httpFailure(text);
      return { status: "error", ...(error ? { error } : {}) };
    }
    case "max_output_tokens":
      return { status: "error", error: new Error("fx reached the model's output limit. Send a message to continue.") };
    case "max_model_turns":
      return { status: "max_turns" };
    case "yielded":
      return { status: "cancelled" };
    default:
      return undefined;
  }
}

function httpFailure(text: string): Error | undefined {
  const body = /^HTTP [45]\d{2}: ([\s\S]+)$/.exec(text.trim())?.[1];
  if (!body) return undefined;
  try {
    if (providerError.safeParse(JSON.parse(body)).success) return new Error(text);
  } catch {
    // Ordinary replies and unstructured refusals stay visible without an invented account diagnosis.
  }
  return undefined;
}
