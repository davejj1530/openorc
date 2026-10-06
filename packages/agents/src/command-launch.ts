import type { SpawnOptions } from "node:child_process";

/** What to hand spawn or execFile for one command on this platform. */
export interface CommandLaunch {
  file: string;
  args: string[];
  options: Pick<SpawnOptions, "windowsHide" | "windowsVerbatimArguments">;
}

/** Characters cmd.exe treats specially, each escaped with ^. */
const cmdSpecial = /([()\][%!^"`<>&|;, *?])/g;

/**
 * Windows starts a .cmd or .bat file, which is how npm installs Codex and OpenCode, only through cmd.exe, and
 * cmd.exe reads the command line itself. So the line is quoted and escaped here, the way cross-spawn does it, and
 * cmd.exe receives it unchanged. Everywhere else the command runs as given. No console window opens on Windows.
 */
export function launchCommand(binary: string, args: readonly string[], platform: NodeJS.Platform = process.platform, comspec = process.env["ComSpec"]): CommandLaunch {
  if (platform !== "win32" || !/\.(cmd|bat)$/i.test(binary)) return { file: binary, args: [...args], options: { windowsHide: true } };
  if (args.some((arg) => /[\r\n]/.test(arg))) throw new Error("cmd.exe cannot pass a line break to a program");
  const line = [binary.replace(cmdSpecial, "^$1"), ...args.map(cmdArgument)].join(" ");
  return { file: comspec || "cmd.exe", args: ["/d", "/s", "/c", `"${line}"`], options: { windowsHide: true, windowsVerbatimArguments: true } };
}

/**
 * Quoted the way the program behind the launcher splits its command line, then escaped for cmd.exe twice: once for
 * the line cmd.exe runs, and again because the launcher passes its arguments on with %*, which cmd.exe reads again.
 */
function cmdArgument(arg: string): string {
  const quoted = `"${arg.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"').replace(/(?=(\\+?)?)\1$/, "$1$1")}"`;
  return quoted.replace(cmdSpecial, "^$1").replace(cmdSpecial, "^$1");
}
