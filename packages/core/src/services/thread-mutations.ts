import { isSubagentThread, type Thread } from "@openorc/protocol";

/** Hosted transcripts never own their copied workspace or execution settings. */
export function assertMutableThread(thread: Thread): void {
  if (isSubagentThread(thread)) throw new Error("A subagent thread is read-only. Continue in its parent thread.");
}
