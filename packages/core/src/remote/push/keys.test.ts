import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Db } from "@openorc/db";
import { PushKeys } from "./keys.js";

const pem = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ format: "pem", type: "pkcs8" }).toString();
const log = { info() {}, warn() {}, error() {} };

/** Protected storage whose next read waits until the test lets it answer with what it held when asked. */
function slowSecrets() {
  let saved: string | null = null;
  const waiting: (() => void)[] = [];
  return {
    store: {
      load: () => {
        const held = saved;
        return new Promise<string | null>((resolve) => waiting.push(() => resolve(held)));
      },
      save: async (value: string) => void (saved = value),
    },
    answer: () => waiting.splice(0).forEach((resolve) => resolve()),
  };
}

describe("the push key", () => {
  it("keeps no route built from a key removed while the key was being read", async () => {
    const secrets = slowSecrets();
    const keys = new PushKeys({ db: Db.memory(), secrets: secrets.store, log });
    await keys.set("ABC123DEFG", pem);
    const building = keys.current();
    await keys.remove();
    secrets.answer();
    expect(await building).toBeNull();
    const after = keys.current();
    secrets.answer();
    expect(await after).toBeNull();
  });

  it("builds the route once and keeps it until the key changes", async () => {
    const secrets = slowSecrets();
    const keys = new PushKeys({ db: Db.memory(), secrets: secrets.store, log });
    await keys.set("ABC123DEFG", pem);
    const first = keys.current();
    secrets.answer();
    const route = await first;
    expect(route).not.toBeNull();
    expect(await keys.current()).toBe(route);
    await keys.set("ABC123DEFG", pem);
    const next = keys.current();
    secrets.answer();
    expect(await next).not.toBe(route);
  });
});
