import path from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentCommand } from "../acp/profile.js";

/**
 * OpenCode's ACP server refuses a second prompt while a turn runs, but its own server takes one into the turn: a message
 * admitted with `delivery: "steer"` joins it at the next step, as OpenCode's own app sends it. The ACP session's id is
 * OpenCode's, and `opencode api` reaches the background service the ACP server works through. Pictures go by path,
 * which OpenCode reads itself, so a large one never has to fit on the command line.
 */
export async function steerOpenCode(run: AgentCommand, sessionId: string, text: string, images: string[] = []): Promise<"accepted" | "unavailable"> {
  const files = images.map((image) => ({ uri: pathToFileURL(image).href, name: path.basename(image) }));
  let printed: string;
  try {
    printed = await run(["api", "session.prompt", "--param", `sessionID=${sessionId}`, "--data", JSON.stringify({ text, ...(files.length ? { files } : {}), delivery: "steer" })]);
  } catch (error) {
    throw new Error(`OpenCode did not take the message: ${error instanceof Error ? error.message : String(error)}`);
  }
  const admitted = (JSON.parse(printed) as { data?: { delivery?: unknown } } | null)?.data;
  return admitted?.delivery === "steer" ? "accepted" : "unavailable";
}
