import fs from "node:fs";
import path from "node:path";

/**
 * The Claude file-boundary hook's answer, worked out in the VM where the files are. The same check as
 * `fileBoundaryAnswer` in @openorc/mcp, which answers it for agents on the Mac; a test holds the two together.
 * Throws when the address or request is incomplete, which blocks the tool.
 */
export function fileBoundaryAnswer(query: URLSearchParams, request: unknown): object {
  const root = query.get("root");
  const cwd = query.get("cwd");
  const outside = query.get("outside");
  if (!root || !cwd || (outside !== "ask" && outside !== "deny")) throw new Error("The address names no boundary.");
  const input = (request as { tool_input?: { file_path?: unknown; notebook_path?: unknown } } | null)?.tool_input;
  const raw = input?.file_path ?? input?.notebook_path;
  if (typeof raw !== "string") throw new Error("The request names no file.");
  let target = path.resolve(cwd, raw);
  const missing: string[] = [];
  while (!fs.existsSync(target)) {
    missing.unshift(path.basename(target));
    const parent = path.dirname(target);
    if (parent === target) throw new Error("The path has no existing parent.");
    target = parent;
  }
  const real = path.resolve(fs.realpathSync(target), ...missing);
  const relative = path.relative(fs.realpathSync(root), real);
  const inside = relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  if (inside) return {};
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: outside,
      permissionDecisionReason: "This file is outside the mode’s permitted directory.",
    },
  };
}
