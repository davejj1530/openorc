import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UtilityProcess } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProtectedSecretsClient } from "../core/protected-secrets";
import { installProtectedSecrets } from "./protected-secrets";

const os = vi.hoisted(() => ({ available: true, backend: "keychain" }));
// Exercise the real IPC/file lifecycle with authenticated encryption, without
// touching the developer's OS keychain. OS-specific safeStorage is mocked here.
vi.mock("electron", () => {
  const key = randomBytes(32);
  return {
    safeStorage: {
      isEncryptionAvailable: () => os.available,
      getSelectedStorageBackend: () => os.backend,
      encryptString: (value: string) => {
        const nonce = randomBytes(12);
        const cipher = createCipheriv("aes-256-gcm", key, nonce);
        const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
        return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]);
      },
      decryptString: (value: Buffer) => {
        const decipher = createDecipheriv("aes-256-gcm", key, value.subarray(0, 12));
        decipher.setAuthTag(value.subarray(12, 28));
        return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString("utf8");
      },
    },
  };
});
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open), rename: vi.fn(actual.rename) };
});
let dataDir: string;
const platform = process.platform;
beforeEach(async () => {
  os.available = true;
  os.backend = "keychain";
  dataDir = await mkdtemp(join(tmpdir(), "openorc-secrets-test-"));
});
afterEach(async () => {
  Object.defineProperty(process, "platform", { value: platform });
  vi.clearAllMocks();
  await rm(dataDir, { recursive: true, force: true });
});
function connect() {
  const child = new EventEmitter() as EventEmitter & { postMessage(message: unknown): void };
  const client = new ProtectedSecretsClient((message) => child.emit("message", message));
  child.postMessage = vi.fn((message) => {
    client.receive(message);
  });
  installProtectedSecrets(child as unknown as UtilityProcess, dataDir);
  return { child, memory: client.store("memory.secrets"), slack: client.store("slack.secrets"), github: client.store("github.secrets") };
}

describe("desktop protected stores", () => {
  it("persists encrypted, owner-only values through reconnect, replacement, and clear", async () => {
    const { memory } = connect();
    await memory.save("fixture-secret-never-plaintext");
    const file = join(dataDir, "memory-extraction-key.enc");
    expect((await readFile(file)).includes("fixture-secret-never-plaintext")).toBe(false);
    if (platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
    await expect(connect().memory.load()).resolves.toBe("fixture-secret-never-plaintext");
    await memory.save("replacement-fixture");
    await expect(memory.load()).resolves.toBe("replacement-fixture");
    await memory.save("");
    await expect(connect().memory.load()).resolves.toBe("");
  });

  it("keeps the existing Slack file and isolates it from memory writes", async () => {
    const { safeStorage } = await import("electron");
    await writeFile(join(dataDir, "slack-secrets.enc"), safeStorage.encryptString('{"devices":[],"fixture":"slack"}'));
    const { memory, slack } = connect();
    await memory.save("memory-fixture");
    await expect(slack.load()).resolves.toBe('{"devices":[],"fixture":"slack"}');
    await slack.save('{"devices":[]}');
    await expect(memory.load()).resolves.toBe("memory-fixture");
    await expect(connect().slack.load()).resolves.toBe('{"devices":[]}');
  });

  it("keeps the reviewer app's key in a file of its own", async () => {
    const { memory, github } = connect();
    await memory.save("memory-fixture");
    await github.save("reviewer-key-fixture");
    expect((await readFile(join(dataDir, "github-reviewer-app.enc"))).includes("reviewer-key-fixture")).toBe(false);
    await expect(connect().github.load()).resolves.toBe("reviewer-key-fixture");
    await expect(memory.load()).resolves.toBe("memory-fixture");
  });

  it("orders simultaneous saves and loads per store", async () => {
    const { memory } = connect();
    const first = memory.save("first-fixture");
    const second = memory.save("second-fixture");
    const read = memory.load();
    const clear = memory.save("");
    await Promise.all([first, second, clear]);
    await expect(read).resolves.toBe("second-fixture");
    await expect(memory.load()).resolves.toBe("");
    expect(await readdir(dataDir)).toEqual(["memory-extraction-key.enc"]);
  });

  it("lets an empty profile load with unavailable encryption but rejects saves", async () => {
    os.available = false;
    const { memory } = connect();
    await expect(memory.load()).resolves.toBeNull();
    await expect(memory.save("fixture-secret")).rejects.toThrow(/Unlock your OS keychain/);
    expect(await readdir(dataDir)).toEqual([]);
  });

  it("preserves an existing file when the OS store becomes locked", async () => {
    const { memory } = connect();
    await memory.save("fixture-secret");
    const file = join(dataDir, "memory-extraction-key.enc");
    const before = await readFile(file);
    os.available = false;
    await expect(memory.load()).rejects.toThrow(/protected storage/);
    await expect(memory.save("")).rejects.toThrow(/protected storage/);
    expect(await readFile(file)).toEqual(before);
    os.available = true;
    await expect(memory.load()).resolves.toBe("fixture-secret");
  });

  it("rejects Linux basic_text storage even when encryption reports available", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    os.backend = "basic_text";
    await expect(connect().memory.save("fixture-secret")).rejects.toThrow(/protected storage/);
    expect(await readdir(dataDir)).toEqual([]);
  });

  it("does not expose corrupt file contents or raw OS errors", async () => {
    await writeFile(join(dataDir, "memory-extraction-key.enc"), "corrupt-secret-fixture");
    const { child, memory } = connect();
    await expect(memory.load()).rejects.toThrow(/protected storage/);
    expect(JSON.stringify(vi.mocked(child.postMessage).mock.calls)).not.toContain("corrupt-secret-fixture");
  });

  it("preserves the old file on failed rename and cleans up temporary ciphertext", async () => {
    const { memory } = connect();
    await memory.save("old-fixture");
    vi.mocked(rename).mockRejectedValueOnce(new Error("raw error with new-fixture"));
    await expect(memory.save("new-fixture")).rejects.toThrow(/protected storage/);
    await expect(memory.load()).resolves.toBe("old-fixture");
    expect(await readdir(dataDir)).toEqual(["memory-extraction-key.enc"]);
    await memory.save("retry-fixture");
    await expect(memory.load()).resolves.toBe("retry-fixture");
  });

  it.skipIf(platform === "win32")("reports a post-rename directory sync failure and can durably retry the surviving value", async () => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(open).mockImplementation(async (...args) => {
      const handle = await actual.open(...args);
      if (args[0] === dataDir) vi.spyOn(handle, "sync").mockRejectedValueOnce(new Error("directory sync error"));
      return handle;
    });
    const { memory } = connect();
    try {
      await expect(memory.save("fixture-durable-retry")).rejects.toThrow(/protected storage/);
    } finally {
      vi.mocked(open).mockImplementation(actual.open);
    }
    await expect(memory.load()).resolves.toBe("fixture-durable-retry");
    await memory.save("fixture-durable-retry");
    await expect(connect().memory.load()).resolves.toBe("fixture-durable-retry");
  });

  it("ignores arbitrary channels and rejects malformed operations", async () => {
    const { child } = connect();
    child.emit("message", { type: "../../secret", id: 1, operation: "save", value: "fixture" });
    child.emit("message", { type: "memory.secrets", id: "1", operation: "save", value: "fixture" });
    expect(child.postMessage).not.toHaveBeenCalled();
    child.emit("message", { type: "memory.secrets", id: 1, operation: "delete", value: "fixture" });
    await vi.waitFor(() => expect(child.postMessage).toHaveBeenCalledWith(expect.objectContaining({ id: 1, error: expect.any(String) })));
    expect(await readdir(dataDir)).toEqual([]);
  });
});
