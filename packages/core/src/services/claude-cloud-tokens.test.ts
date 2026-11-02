import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClaudeCloudTokens } from "./claude-cloud-tokens.js";

const MINTED = "sk-ant-oat01-Minted_token-for-the-cloud-0123456789";

/**
 * Stands in for `claude setup-token`: it prints the token the way the CLI does, styled, or fails as FAKE_SETUP says.
 * Like the real screen, some modes then wait for a key that never comes.
 */
const FAKE_CLAUDE = `#!/usr/bin/env node
if (process.argv[4] !== "setup-token") process.exit(64);
require("node:fs").writeFileSync(process.env.FAKE_PID, String(process.pid));
const mode = process.env.FAKE_SETUP;
const waitForKey = () => setInterval(() => {}, 1000);
if (mode === "shown") {
  process.stdout.write("Your OAuth token (valid for 1 year):\\n\\u001b[33m${MINTED}\\u001b[39m\\n");
  waitForKey();
}
if (mode === "refused") {
  process.stdout.write("\\u001b[31mOAuth error: Invalid code. Please make sure the full code was copied\\u001b[39m\\n\\nPress Enter to retry. \\n");
  waitForKey();
}
if (mode === "verbatim") {
  process.stdout.write("\\u001b[31mThis organization does not allow long-lived tokens.\\u001b[39m\\n\\n\\u001b[2K\\u001b[1GPress \\u001b[1mEnter\\u001b[22m to retry. \\n");
  waitForKey();
}
if (mode === "paste") {
  process.stdout.write("The browser can't return the sign-in to Claude Code automatically. After you sign in, paste the code shown.\\nPaste code here > ");
  waitForKey();
}
if (mode === "ok")
  setTimeout(() => {
    process.stdout.write("\\u001b[32m✓ Long-lived authentication token created successfully!\\u001b[0m\\n\\nYour OAuth token (valid for 1 year):\\n\\n");
    process.stdout.write("\\u001b[1m${MINTED}\\u001b[0m\\n\\nStore this token securely. You won't be able to see it again.\\n");
  }, 200);
if (mode === "none") console.log("Signed in.");
if (mode === "fail") {
  console.error("OAuth error: access denied");
  process.exit(1);
}
if (mode === "wait") setTimeout(() => {}, 30_000);
`;

let dir: string;
let changes: number;

function memoryStore() {
  let value: string | null = null;
  return { load: async () => value, save: async (next: string) => void (value = next), peek: () => value };
}

function tokens(mode: string, store = memoryStore()) {
  const binary = path.join(dir, "claude");
  writeFileSync(binary, FAKE_CLAUDE);
  chmodSync(binary, 0o755);
  const accounts = { signInLaunch: () => ({ binary, env: { ...process.env, FAKE_SETUP: mode, FAKE_PID: path.join(dir, "pid") }, directory: path.join(dir, "config") }) };
  return { service: new ClaudeCloudTokens(store, accounts, () => void changes++), store };
}

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function settled(service: ClaudeCloudTokens, id: string): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (!(await service.status())[id]?.creating) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("still creating");
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "openorc-cloud-tokens-"));
  changes = 0;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("Claude cloud tokens", () => {
  it("saves the token setup-token prints for the account, without its styling", async () => {
    const { service } = tokens("ok");
    void service.create("work");
    expect((await service.status())["work"]).toEqual({ createdAt: null, creating: true, error: null });
    await settled(service, "work");
    expect(await service.token("work")).toBe(MINTED);
    expect(await service.token("personal")).toBeNull();
    expect((await service.status())["work"]).toEqual({ createdAt: expect.any(Number), creating: false, error: null });
    expect(changes).toBeGreaterThanOrEqual(2);
  });

  it("says what went wrong without repeating anything the command printed", async () => {
    for (const [mode, message] of [
      ["none", "Claude finished without a token. Paste one from claude setup-token instead."],
      ["fail", "The sign-in failed: access denied"],
    ] as const) {
      const { service } = tokens(mode);
      void service.create("work");
      await settled(service, "work");
      expect(await service.status()).toEqual({ work: { createdAt: null, creating: false, error: message } });
      expect(await service.token("work")).toBeNull();
    }
  });

  it("saves the token as soon as the screen shows it, and closes setup-token instead of leaving it waiting for a key", async () => {
    const { service } = tokens("shown");
    void service.create("work");
    await settled(service, "work");
    expect(await service.token("work")).toBe(MINTED);
    expect((await service.status())["work"]).toEqual({ createdAt: expect.any(Number), creating: false, error: null });
    expect(running(Number(readFileSync(path.join(dir, "pid"), "utf8")))).toBe(false);
  });

  it("shows why the sign-in failed in the screen's own words, and closes setup-token instead of waiting to retry", async () => {
    for (const [mode, message] of [
      ["refused", "The sign-in failed: Invalid code. Please make sure the full code was copied"],
      ["verbatim", "The sign-in failed: This organization does not allow long-lived tokens."],
      ["paste", "The browser could not hand the sign-in back to Claude. Run claude setup-token in Terminal and paste the token."],
    ] as const) {
      const { service } = tokens(mode);
      void service.create("work");
      await settled(service, "work");
      expect(await service.status()).toEqual({ work: { createdAt: null, creating: false, error: message } });
      expect(running(Number(readFileSync(path.join(dir, "pid"), "utf8")))).toBe(false);
    }
  });

  it("stops quietly when the sign-in is cancelled", async () => {
    const { service } = tokens("wait");
    void service.create("work");
    service.cancel("work");
    await settled(service, "work");
    expect(await service.status()).toEqual({});
  });

  it("keeps just the token from a pasted export line, and removes one account's token alone", async () => {
    const { service, store } = tokens("ok");
    await service.save("work", `export CLAUDE_CODE_OAUTH_TOKEN=${MINTED}`);
    await service.save("personal", "sk-ant-oat01-Another_token-0123456789abcdef");
    expect(await service.token("work")).toBe(MINTED);
    await service.remove("personal");
    expect(Object.keys(JSON.parse(store.peek()!))).toEqual(["work"]);
    expect(await new ClaudeCloudTokens(store, { signInLaunch: () => ({ binary: "", env: {}, directory: dir }) }, () => {}).token("work")).toBe(MINTED);
  });

  it("refuses to read or save when protected storage is locked, naming only the storage", async () => {
    const locked = { load: () => Promise.reject(new Error("keychain locked")), save: () => Promise.reject(new Error("keychain locked")) };
    const { service } = tokens("ok", locked as unknown as ReturnType<typeof memoryStore>);
    await expect(service.token("work")).rejects.toThrow("Cannot access protected storage for Claude cloud tokens.");
    await expect(service.save("work", MINTED)).rejects.toThrow("Cannot access protected storage for Claude cloud tokens.");
  });
});
