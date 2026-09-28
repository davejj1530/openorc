import { useIsMutating } from "@tanstack/react-query";

/** A workspace write can outlive its panel. Other controls must wait for its reply. */
/** Thread patches that only record what the user is looking at or typing; they never change team state and must not disable its controls. */
const bookkeeping = new Set(["seen", "draft"]);

export function threadMutationBlocks(threadId: string, value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const record = value as { id?: unknown; threadId?: unknown; patch?: unknown };
  if (record.id !== threadId && record.threadId !== threadId) return false;
  const patch = record.patch;
  if (patch && typeof patch === "object" && Object.keys(patch).every((key) => bookkeeping.has(key))) return false;
  return true;
}

export function useThreadMutationPending(threadId: string): boolean {
  return useIsMutating({ predicate: (mutation) => threadMutationBlocks(threadId, mutation.state.variables) }) > 0;
}
