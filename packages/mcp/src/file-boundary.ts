import fs from "node:fs";
import path from "node:path";
import type { FileBoundary } from "@openorc/protocol";

/** Empty inside the boundary, so the mode's own rules apply. */
export interface FileBoundaryAnswer {
  hookSpecificOutput?: { hookEventName: "PreToolUse"; permissionDecision: FileBoundary["outside"]; permissionDecisionReason: string };
}

/**
 * Claude Code's PreToolUse answer for one file edit. A path inside the boundary gets an empty answer, so the mode's own
 * rules apply; any other path gets `outside`. Symlinks are followed, so a link inside `root` that leads out of it is
 * outside. A file that does not exist yet is checked through its nearest existing parent. Throws when the request
 * names no file or the path cannot be resolved, which blocks the tool.
 */
export function fileBoundaryAnswer(boundary: FileBoundary, request: unknown): FileBoundaryAnswer {
  const input = (request as { tool_input?: { file_path?: unknown; notebook_path?: unknown } } | null)?.tool_input;
  const raw = input?.file_path ?? input?.notebook_path;
  if (typeof raw !== "string") throw new Error("The request names no file.");
  let target = path.resolve(boundary.cwd, raw);
  const missing: string[] = [];
  while (!fs.existsSync(target)) {
    missing.unshift(path.basename(target));
    const parent = path.dirname(target);
    if (parent === target) throw new Error("The path has no existing parent.");
    target = parent;
  }
  const real = path.resolve(fs.realpathSync(target), ...missing);
  const relative = path.relative(fs.realpathSync(boundary.root), real);
  const inside = relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  if (inside) return {};
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: boundary.outside,
      permissionDecisionReason: "This file is outside the mode’s permitted directory.",
    },
  };
}
