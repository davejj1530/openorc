import { titleFromPrompt, type ThreadSummary } from "@openorc/protocol";
import type { Logger } from "../transport.js";
import type { ThreadTitler } from "./thread-inputs.js";

/** A proposal, applied only if the stored title still matches after the model answers. */
export async function nameThread(
  thread: Pick<ThreadSummary, "id" | "title" | "agent" | "claudeAccountId">,
  exchange: { prompt: string | null; reply: string | null },
  titler: ThreadTitler,
  log: Pick<Logger, "warn">,
): Promise<{ title: string; expectedTitle: string } | null> {
  if (!exchange.prompt || thread.title !== titleFromPrompt(exchange.prompt)) return null;
  try {
    const title = await titler({ request: exchange.prompt, reply: exchange.reply }, thread.agent, thread.claudeAccountId ?? "claude-cli");
    return title?.trim() ? { title, expectedTitle: thread.title } : null;
  } catch (error) {
    log.warn(`could not name thread ${thread.id}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}
