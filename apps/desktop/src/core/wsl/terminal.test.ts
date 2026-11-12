import { existsSync } from "node:fs";
import os from "node:os";
import { describe, expect, it } from "vitest";
import { scriptTerminal, terminalLine } from "./terminal";

const SCRIPT = "/usr/bin/script";
// util-linux's script, which a distribution carries. macOS has a program of the same name that takes other switches.
const hasScript = process.platform === "linux" && existsSync(SCRIPT);

/** Runs a command to its end in the terminal and gives back what it drew and how it ended. */
async function run(terminal: ReturnType<typeof scriptTerminal>, binary: string, args: string[]): Promise<{ output: string; code: number | null }> {
  const proc = await terminal(binary, args, { cwd: os.tmpdir(), env: { PATH: process.env["PATH"] ?? "", HOME: os.tmpdir() } });
  let output = "";
  proc.onData((data) => (output += data));
  const code = await new Promise<number | null>((resolve) => proc.onExit(resolve));
  return { output, code };
}

describe("a sign-in terminal inside a distribution", () => {
  it("quotes the command so the shell reads each word as it stands", () => {
    expect(terminalLine("/home/me/.local/bin/claude", ["--setting-sources", "user", "setup-token"])).toBe(
      "stty cols 400 rows 40 2>/dev/null; exec '/home/me/.local/bin/claude' '--setting-sources' 'user' 'setup-token'",
    );
    expect(terminalLine("/opt/my tools/it's", ["$(rm -rf ~)", "a;b"])).toBe(`stty cols 400 rows 40 2>/dev/null; exec '/opt/my tools/it'\\''s' '$(rm -rf ~)' 'a;b'`);
  });

  it.runIf(hasScript)("gives the command a real terminal, wide enough for a token, and reports its exit", async () => {
    const { output, code } = await run(
      scriptTerminal(async () => SCRIPT),
      "/bin/sh",
      ["-c", 'test -t 1 && echo "is a terminal"; stty size; exit 7'],
    );
    expect(output).toContain("is a terminal");
    expect(output).toContain("40 400");
    expect(code).toBe(7);
  });

  it.runIf(hasScript)("passes arguments through unread by any shell", async () => {
    const { output } = await run(
      scriptTerminal(async () => SCRIPT),
      "/bin/sh",
      ["-c", 'printf "%s|" "$@"', "sh", "two words", "$HOME", "it's"],
    );
    expect(output).toContain("two words|$HOME|it's|");
  });

  it.runIf(process.platform !== "win32")("falls back to pipes where the distribution has no script", async () => {
    const { output, code } = await run(
      scriptTerminal(async () => null),
      "/bin/sh",
      ["-c", 'test -t 1 || echo "no terminal"; exit 3'],
    );
    expect(output).toContain("no terminal");
    expect(code).toBe(3);
  });

  it.runIf(hasScript)("ends a command that waits for a key", async () => {
    const proc = await scriptTerminal(async () => SCRIPT)("/bin/sh", ["-c", "echo waiting; read answer"], { cwd: os.tmpdir(), env: { PATH: process.env["PATH"] ?? "" } });
    const ended = new Promise<number | null>((resolve) => proc.onExit(resolve));
    await new Promise<void>((resolve) => proc.onData((data) => data.includes("waiting") && resolve()));
    proc.kill();
    await expect(Promise.race([ended.then(() => "ended"), new Promise((resolve) => setTimeout(() => resolve("still running"), 5000))])).resolves.toBe("ended");
  });
});
