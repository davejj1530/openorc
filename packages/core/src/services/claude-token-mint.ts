/**
 * One way to make a long-lived Claude token: `claude setup-token`, run as one of this Mac's Claude accounts in a
 * terminal, its token read off the screen. Two keepers use what it makes: `ClaudeCloudTokens` saves it in protected
 * storage for the person's own cloud service, and the OpenOrc account hands it to OpenOrc Cloud and keeps it nowhere.
 */
import { mkdirSync } from "node:fs";
import { stripAnsi } from "@openorc/agents";
import type { SpawnTerminal } from "./terminal-process.js";

/** How `claude setup-token` prints the token it made. */
export const CLAUDE_TOKEN = /sk-ant-oat\d+-[A-Za-z0-9_-]{20,}/;
/** What setup-token's screen shows when the sign-in failed, above a hint to press Enter to try again, which it waits for. */
const FAILED = /OAuth error: ([^\r\n]+)/;
const RETRY = /Press Enter to retry\./;
/** The screen setup-token falls back to when the browser cannot hand the sign-in back to it. */
const PASTE_PROMPT = /Paste code here/;
const CREATE_TIMEOUT_MS = 5 * 60_000;
/** More output than a sign-in prints means something else is talking; the token would be in the first part. */
const OUTPUT_LIMIT = 64 * 1024;

/** How a Claude account of this Mac's runs the CLI to sign in. */
export interface ClaudeSignInLaunch {
  signInLaunch(id: string): { binary: string; env: NodeJS.ProcessEnv; directory: string };
}

/** One run of `claude setup-token`. */
export interface TokenMint {
  /**
   * The token as soon as the command's screen shows it. Rejects with words that never repeat the token: the sign-in
   * failed (the CLI's own reason), the browser could not hand it back, it timed out, it could not start, or it was
   * cancelled, which rejects with an empty message that callers show nothing for.
   */
  token: Promise<string>;
  cancel(): void;
}

/** Runs setup-token as the Claude account `id` and reads the token off its screen. The token is kept nowhere here. */
export function mintClaudeToken(accounts: ClaudeSignInLaunch, terminal: SpawnTerminal, id: string): TokenMint {
  let stop = () => undefined as void;
  let cancelled = false;
  const token = (async () => {
    let proc: Awaited<ReturnType<SpawnTerminal>>;
    try {
      const { binary, env, directory } = accounts.signInLaunch(id);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      proc = await terminal(binary, ["--setting-sources", "user", "setup-token"], { cwd: directory, env });
    } catch {
      throw new Error("Claude could not start making a token. Check its installation and retry.");
    }
    return new Promise<string>((resolve, reject) => {
      stop = () => proc.kill();
      if (cancelled) proc.kill();
      let screen = "";
      let found: string | null = null;
      let failure: string | null = null;
      proc.onData((chunk) => {
        if (found || screen.length >= OUTPUT_LIMIT) return;
        screen += chunk;
        const text = stripAnsi(screen);
        found = CLAUDE_TOKEN.exec(text)?.[0] ?? null;
        failure = found ? null : failureOf(text);
        if (found || failure) proc.kill();
      });
      const timer = setTimeout(() => proc.kill(), CREATE_TIMEOUT_MS);
      timer.unref();
      proc.onExit((code) => {
        clearTimeout(timer);
        if (cancelled) return reject(new Error(""));
        if (found) return resolve(found);
        reject(
          new Error(
            failure ?? (code === 0 ? "Claude finished without a token. Paste one from claude setup-token instead." : "Making the token did not finish. Retry and complete the browser sign-in."),
          ),
        );
      });
    });
  })();
  return {
    token,
    cancel: () => {
      cancelled = true;
      stop();
    },
  };
}

/** Why setup-token's screen says the sign-in failed, in its own words; null while it has not. */
function failureOf(screen: string): string | null {
  const retry = screen.search(RETRY);
  // Some failures are shown as they are, without the prefix: the line above the hint says why.
  const failed =
    FAILED.exec(screen)?.[1]?.trim() ??
    (retry >= 0
      ? screen
          .slice(0, retry)
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
          .at(-1)
      : null);
  if (failed) return `The sign-in failed: ${failed.replace(CLAUDE_TOKEN, "")}`;
  if (PASTE_PROMPT.test(screen)) return "The browser could not hand the sign-in back to Claude. Run claude setup-token in Terminal and paste the token.";
  return null;
}
