import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileBoundaryUrl, type FileBoundary } from "@openorc/protocol";

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * A PreToolUse hook command that has OpenOrc check each file path. Only the real path can show that a symlink inside
 * the directory leads out of it, and a hook cannot count on a JavaScript runtime, so curl posts Claude Code's request to
 * the run's address and prints OpenOrc's answer. The address carries the run's secret, so it sits in a curl config file
 * in `dir`, which only this user can read, never in the command. The config also skips the user's .curlrc and any
 * proxy, so the request stays on this machine. Any failure, such as OpenOrc not answering, exits 2, which blocks the
 * tool. Without an address, every edit is blocked.
 */
export function fileBoundaryHook(boundary: FileBoundary, connection: { mcpUrl: string; dir: string } | null): string {
  const blocked = "{ echo 'OpenOrc could not check this file path, so the tool is blocked.' >&2; exit 2; }";
  if (!connection) return blocked;
  const config = path.join(connection.dir, "file-boundary.curlrc");
  const options = [`url = "${fileBoundaryUrl(connection.mcpUrl, boundary)}"`, 'header = "content-type: application/json"', 'noproxy = "*"', "max-time = 10", "silent", "fail"];
  writeFileSync(config, `${options.join("\n")}\n`, { mode: 0o600 });
  // -q must come first: it keeps the user's .curlrc out.
  return `curl -q -K ${quote(config)} --data-binary @- || ${blocked}`;
}
