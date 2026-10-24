import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { Db } from "./database.js";
import { remoteDeviceMigration } from "./remote-device-schema.js";
import { remoteDevices } from "./remote-devices.js";
import { projects } from "./repos.js";
import { migrations } from "./schema.js";

const opened: Db[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
});
function memory(): Db {
  const db = Db.memory();
  opened.push(db);
  return db;
}
const key = () => new Uint8Array(randomBytes(32));

describe("remote devices", () => {
  it("keeps one row per phone key, however often it pairs, with the newest name", () => {
    const db = memory();
    const phone = key();
    const first = remoteDevices.upsert(db, { publicKey: phone, name: "iPhone", at: 100 });
    const again = remoteDevices.upsert(db, { publicKey: Uint8Array.from(phone), name: "David's iPhone", at: 200 });
    expect(again).toEqual({ id: first.id, name: "David's iPhone", publicKey: phone, createdAt: 100, lastSeenAt: 200 });
    expect(remoteDevices.list(db)).toEqual([again]);
  });

  it("finds a device by its key, records when it was seen, and removes it once", () => {
    const db = memory();
    const [a, b] = [key(), key()];
    const first = remoteDevices.upsert(db, { publicKey: a, name: "Phone A", at: 1 });
    const second = remoteDevices.upsert(db, { publicKey: b, name: "Phone B", at: 2 });
    expect(remoteDevices.byKey(db, b)?.id).toBe(second.id);
    expect(remoteDevices.byKey(db, key())).toBeNull();
    remoteDevices.touch(db, first.id, 50);
    expect(remoteDevices.byKey(db, a)?.lastSeenAt).toBe(50);
    expect(remoteDevices.remove(db, first.id)).toBe(true);
    expect(remoteDevices.remove(db, first.id)).toBe(false);
    expect(remoteDevices.list(db).map((device) => device.name)).toEqual(["Phone B"]);
  });

  it("refuses a key that is not an X25519 public key", () => {
    expect(() => remoteDevices.upsert(memory(), { publicKey: new Uint8Array(31), name: "Short", at: 1 })).toThrow(/CHECK constraint/);
  });

  it("adds the table to a ledger written before it, keeping existing rows", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "openorc-remote-devices-migration-"));
    const file = path.join(directory, "before.sqlite");
    try {
      const raw = new DatabaseSync(file);
      const before = migrations.indexOf(remoteDeviceMigration);
      for (const migration of migrations.slice(0, before)) typeof migration === "string" ? raw.exec(migration) : migration(raw);
      raw.exec(`PRAGMA user_version = ${before}`);
      raw.exec("INSERT INTO projects (id,name,root_path,default_branch,settings,created_at,updated_at) VALUES ('p','Fixture','/fixture','main','{}',1,1)");
      raw.close();

      const db = Db.open(file);
      expect(db.version).toBe(migrations.length);
      expect(projects.get(db, "p")?.name).toBe("Fixture");
      const device = remoteDevices.upsert(db, { publicKey: key(), name: "Phone", at: 5 });
      expect(db.raw.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      db.close();

      const reopened = Db.open(file);
      expect(remoteDevices.list(reopened)).toEqual([device]);
      reopened.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
