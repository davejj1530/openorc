import { spawn } from "node:child_process";
import { launchCommand, stopProcess } from "@openorc/agents";

/** A command whose screen OpenOrc reads as it draws, such as a CLI's sign-in. */
export interface TerminalProcess {
  onData(listener: (data: string) => void): void;
  /** Called once, when the command has ended. */
  onExit(listener: (code: number | null) => void): void;
  kill(): void;
}

/**
 * Starts a command in a terminal of its own. Interactive CLIs draw their screens and take keys only in one; without it
 * they may draw nothing and wait for a key that never comes.
 */
export type SpawnTerminal = (binary: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => Promise<TerminalProcess>;

/** Where no terminal is available, as in tests: the command gets pipes, and a screen that waits for a key waits on. */
export const spawnWithPipes: SpawnTerminal = async (binary, args, { cwd, env }) => {
  const command = launchCommand(binary, args);
  const child = spawn(command.file, command.args, { ...command.options, cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
  return {
    onData: (listener) => {
      child.stdout?.on("data", (chunk: Buffer) => listener(chunk.toString("utf8")));
      child.stderr?.on("data", (chunk: Buffer) => listener(chunk.toString("utf8")));
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
    kill: () => stopProcess(child),
  };
};
