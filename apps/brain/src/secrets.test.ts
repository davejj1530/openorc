import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { brainKeyText, newBrainKey, SealedUnreadable } from "@openorc/cloud";
import { BRAIN_SECRETS, SealedSecrets, WrongBrainKey } from "./secrets.js";

const PHONE_KEYS = JSON.stringify({ privateKey: "phone-private-key-fixture", publicKey: "phone-public-key-fixture" });

let dir: string;

beforeEach(async () => {
  dir = path.join(await mkdtemp(path.join(os.tmpdir(), "openorc-brain-secrets-")), "secrets");
});

afterEach(async () => {
  await rm(path.dirname(dir), { recursive: true, force: true });
});

async function everyByte(): Promise<string> {
  const names = await readdir(dir);
  return (await Promise.all(names.map((name) => readFile(path.join(dir, name))))).map((bytes) => bytes.toString("latin1")).join("\n");
}

describe("sealed secrets", () => {
  it("gives back what it saved, after the brain starts again with its key", async () => {
    const key = newBrainKey();
    const first = await SealedSecrets.open(dir, key);
    expect(await first.store("remote").load()).toBeNull();
    await first.store("remote").save(PHONE_KEYS);
    await first.store("push").save("push-key");
    const again = await SealedSecrets.open(dir, key);
    expect(await again.store("remote").load()).toBe(PHONE_KEYS);
    expect(await again.store("push").load()).toBe("push-key");
  });

  it("keeps neither the plaintext nor the key on disk, in files only the brain's user can read", async () => {
    const key = newBrainKey();
    await (await SealedSecrets.open(dir, key)).store("remote").save(PHONE_KEYS);
    const bytes = await everyByte();
    expect(bytes).not.toContain("phone-private-key-fixture");
    expect(bytes).not.toContain(brainKeyText(key));
    expect(bytes).not.toContain(Buffer.from(key).toString("latin1"));
    expect((await readdir(dir)).sort()).toEqual(["key-check", "remote.sealed"]);
    expect((await stat(path.join(dir, "remote.sealed"))).mode & 0o777).toBe(0o600);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
  });

  it("refuses another key before anything is read, and leaves the files as they were", async () => {
    await (await SealedSecrets.open(dir, newBrainKey())).store("remote").save(PHONE_KEYS);
    const before = await everyByte();
    await expect(SealedSecrets.open(dir, newBrainKey())).rejects.toThrow(WrongBrainKey);
    expect(await everyByte()).toBe(before);
  });

  it("refuses to record a key beside sealed files that came without a check", async () => {
    await (await SealedSecrets.open(dir, newBrainKey())).store("remote").save(PHONE_KEYS);
    await rm(path.join(dir, "key-check"));
    await expect(SealedSecrets.open(dir, newBrainKey())).rejects.toThrow(WrongBrainKey);
    expect(await readdir(dir)).toEqual(["remote.sealed"]);
  });

  it("throws on a file that does not open, so the core never replaces a secret it could not read", async () => {
    const key = newBrainKey();
    const secrets = await SealedSecrets.open(dir, key);
    await secrets.store("remote").save(PHONE_KEYS);
    const file = path.join(dir, "remote.sealed");
    const bytes = await readFile(file);
    bytes.writeUInt8(bytes.readUInt8(bytes.length - 1) ^ 1, bytes.length - 1);
    await writeFile(file, bytes);
    await expect(secrets.store("remote").load()).rejects.toThrow(SealedUnreadable);
  });

  it("seals each channel under its own key, so a file moved to another channel does not open", async () => {
    const secrets = await SealedSecrets.open(dir, newBrainKey());
    await secrets.store("push").save("push-key");
    await writeFile(path.join(dir, "remote.sealed"), await readFile(path.join(dir, "push.sealed")));
    await expect(secrets.store("remote").load()).rejects.toThrow(SealedUnreadable);
  });

  it("applies saves to one channel in the order they were asked", async () => {
    const secrets = await SealedSecrets.open(dir, newBrainKey());
    const store = secrets.store("memory");
    await Promise.all(Array.from({ length: 20 }, (_, index) => store.save(`value ${index}`)));
    expect(await store.load()).toBe("value 19");
    expect((await readdir(dir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("gives the core a store for every channel the brain keeps, and none for Slack or the Vercel connection", async () => {
    const stores = (await SealedSecrets.open(dir, newBrainKey())).stores();
    expect(Object.keys(stores).sort()).toEqual([
      "claudeCloudSecrets",
      "cloudEnvSecrets",
      "codexCloudSecrets",
      "githubSecrets",
      "memorySecrets",
      "opencodeCloudSecrets",
      "pushSecrets",
      "remoteSecrets",
    ]);
    await stores.githubSecrets.save("reviewer-app-key");
    expect(await readFile(path.join(dir, `${BRAIN_SECRETS.githubSecrets}.sealed`))).toBeTruthy();
  });
});
