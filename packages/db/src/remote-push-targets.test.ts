import type { PushRegistration } from "@openorc/protocol";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { Db } from "./database.js";
import { remoteDevices } from "./remote-devices.js";
import { remotePushTargetMigration } from "./remote-push-target-schema.js";
import { remotePushTargets } from "./remote-push-targets.js";
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
const token = () => randomBytes(32).toString("hex");
const registration = (overrides: Partial<PushRegistration> = {}): PushRegistration => ({ token: token(), environment: "sandbox", alerts: "all", sound: true, ...overrides });
const phone = (db: Db, name = "iPhone") => remoteDevices.upsert(db, { publicKey: key(), name, at: 1 });

describe("remote push targets", () => {
  it("keeps one row per phone with its newest registration, joined with the phone's key", () => {
    const db = memory();
    const device = phone(db);
    remotePushTargets.set(db, device.id, registration(), 10);
    const latest = registration({ environment: "production", alerts: "needs-you", sound: false });
    remotePushTargets.set(db, device.id, latest, 20);
    expect(remotePushTargets.recipients(db)).toEqual([{ deviceId: device.id, publicKey: device.publicKey, ...latest }]);
    expect(remotePushTargets.recipient(db, device.id)).toEqual({ deviceId: device.id, publicKey: device.publicKey, ...latest });
    expect(remotePushTargets.count(db)).toBe(1);
  });

  it("moves a token to the phone that registers it last", () => {
    const db = memory();
    const [lost, repaired] = [phone(db, "Before"), phone(db, "After")];
    const shared = registration();
    remotePushTargets.set(db, lost.id, shared, 10);
    remotePushTargets.set(db, repaired.id, shared, 20);
    expect(remotePushTargets.recipients(db).map((recipient) => [recipient.deviceId, recipient.token])).toEqual([[repaired.id, shared.token]]);
    expect(remotePushTargets.recipient(db, lost.id)).toBeNull();
  });

  it("forgets a phone's row, or a token APNs called dead, and leaves the others", () => {
    const db = memory();
    const [a, b, c] = [phone(db, "A"), phone(db, "B"), phone(db, "C")];
    const dead = registration();
    remotePushTargets.set(db, a.id, registration(), 1);
    remotePushTargets.set(db, b.id, dead, 1);
    remotePushTargets.set(db, c.id, registration(), 1);
    remotePushTargets.remove(db, a.id);
    remotePushTargets.removeToken(db, dead.token);
    remotePushTargets.remove(db, "no such phone");
    expect(remotePushTargets.recipients(db).map((recipient) => recipient.deviceId)).toEqual([c.id]);
  });

  it("drops a phone's row when the phone is removed", () => {
    const db = memory();
    const [kept, removed] = [phone(db, "Kept"), phone(db, "Removed")];
    remotePushTargets.set(db, kept.id, registration(), 1);
    remotePushTargets.set(db, removed.id, registration(), 1);
    remoteDevices.remove(db, removed.id);
    expect(remotePushTargets.recipients(db).map((recipient) => recipient.deviceId)).toEqual([kept.id]);
    expect(remotePushTargets.recipient(db, removed.id)).toBeNull();
    expect(remotePushTargets.count(db)).toBe(1);
  });

  it("refuses a row for a phone that is not paired", () => {
    expect(() => remotePushTargets.set(memory(), "no such phone", registration(), 1)).toThrow(/FOREIGN KEY/);
  });

  it("adds the table to a ledger written before it, keeping paired phones", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "openorc-remote-push-targets-migration-"));
    const file = path.join(directory, "before.sqlite");
    try {
      const raw = new DatabaseSync(file);
      const before = migrations.indexOf(remotePushTargetMigration);
      expect(before).toBe(56);
      for (const migration of migrations.slice(0, before)) typeof migration === "string" ? raw.exec(migration) : migration(raw);
      raw.exec(`PRAGMA user_version = ${before}`);
      const publicKey = key();
      raw.prepare("INSERT INTO remote_devices (id, name, public_key, created_at, last_seen_at) VALUES ('phone', 'iPhone', ?, 1, NULL)").run(publicKey);
      raw.close();

      const db = Db.open(file);
      expect(db.version).toBe(migrations.length);
      expect(db.raw.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      const kept = registration();
      remotePushTargets.set(db, "phone", kept, 5);
      db.close();

      const reopened = Db.open(file);
      expect(remotePushTargets.recipients(reopened)).toEqual([{ deviceId: "phone", publicKey, ...kept }]);
      remoteDevices.remove(reopened, "phone");
      expect(remotePushTargets.count(reopened)).toBe(0);
      reopened.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
