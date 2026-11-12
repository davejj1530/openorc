import { spawn } from "node:child_process";
import { stopProcess } from "@openorc/agents";
import { resolveBinary, type SpawnTerminal } from "@openorc/core";

/** One word of a shell line, quoted so the shell reads it as it stands. */
const quoted = (word: string) => `'${word.replace(/'/g, `'\\''`)}'`;

/**
 * The line `script` runs: the command in a terminal wide enough that a token is never wrapped across lines. `exec`
 * leaves the command as the terminal's own program, so its exit is the one reported.
 */
export function terminalLine(binary: string, args: readonly string[]): string {
  return `stty cols 400 rows 40 2>/dev/null; exec ${[binary, ...args].map(quoted).join(" ")}`;
}

/**
 * A terminal for CLIs whose sign-in screens need one, inside a WSL distribution. node-pty would need a compiler there,
 * so util-linux's `script`, which a distribution carries already, gives the command its terminal. Where it is missing
 * the command gets pipes, and a screen that waits for a key waits on.
 */
export function scriptTerminal(findScript: (envPath: string) => Promise<string | null> = (envPath) => resolveBinary("script", envPath)): SpawnTerminal {
  return async (binary, args, { cwd, env }) => {
    const script = await findScript(env["PATH"] ?? "");
    const child = script
      ? // -q: no banner; -f: write as it comes; -e: exit as the command did. /bin/sh reads the line, whatever the user's shell is.
        spawn(script, ["-qfec", terminalLine(binary, args), "/dev/null"], { cwd, env: { ...env, SHELL: "/bin/sh" }, stdio: ["pipe", "pipe", "pipe"], detached: true })
      : spawn(binary, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: true });
    // Its input stays open and unused: at the end of its input `script` would type end-of-file into the screen.
    child.stdin.on("error", () => undefined);
    return {
      onData: (listener) => {
        child.stdout.on("data", (chunk: Buffer) => listener(chunk.toString("utf8")));
        child.stderr.on("data", (chunk: Buffer) => listener(chunk.toString("utf8")));
      },
      onExit: (listener) => {
        let ended = false;
        const end = (code: number | null) => {
          if (ended) return;
          ended = true;
          listener(code);
        };
        child.once("error", () => end(null));
        child.once("close", end);
      },
      // Asked from inside its own output listener, so it must not throw: an exiting group can refuse the signal.
      kill: () => {
        try {
          stopProcess(child);
        } catch {
          // It is ending anyway; its exit still reaches onExit.
        }
      },
    };
  };
}
