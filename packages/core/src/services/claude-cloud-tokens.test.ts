import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClaudeCloudTokens } from "./claude-cloud-tokens.js";

const MINTED = "sk-ant-oat01-Minted_token-for-the-cloud-0123456789";

/** Stands in for `claude setup-token`: it prints the token the way the CLI does, styled, or fails as FAKE_SETUP says. */
const FAKE_CLAUDE = `#!/usr/bin/env node
if (process.argv[4] !== "setup-token") process.exit(64);
const mode = process.env.FAKE_SETUP;
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
  const accounts = { signInLaunch: () => ({ binary, env: { ...process.env, FAKE_SETUP: mode }, directory: path.join(dir, "config") }) };
  return { service: new ClaudeCloudTokens(store, accounts, () => void changes++), store };
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
    service.create("work");
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
      ["fail", "Making the token did not finish. Retry and complete the browser sign-in."],
    ] as const) {
      const { service } = tokens(mode);
      service.create("work");
      await settled(service, "work");
      expect(await service.status()).toEqual({ work: { createdAt: null, creating: false, error: message } });
      expect(await service.token("work")).toBeNull();
    }
  });

  it("stops quietly when the sign-in is cancelled", async () => {
    const { service } = tokens("wait");
    service.create("work");
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
