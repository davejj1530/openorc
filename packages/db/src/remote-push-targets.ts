import type { PushAlerts, PushEnvironment, PushRegistration } from "@openorc/protocol";
import type { Db } from "./database.js";

/** A phone the sender writes to: its registration and the public key its alerts are sealed for. */
export interface PushRecipient extends PushRegistration {
  deviceId: string;
  /** remote_devices.public_key: the phone's static key the alert is sealed for. */
  publicKey: Uint8Array;
}

interface Row {
  device_id: string;
  public_key: Uint8Array;
  token: string;
  environment: PushEnvironment;
  alerts: PushAlerts;
  sound: 0 | 1;
}

const SELECT = `SELECT t.device_id, d.public_key, t.token, t.environment, t.alerts, t.sound
  FROM remote_push_targets t JOIN remote_devices d ON d.id = t.device_id`;

const recipientOf = (row: Row): PushRecipient => ({
  deviceId: row.device_id,
  publicKey: new Uint8Array(row.public_key),
  token: row.token,
  environment: row.environment,
  alerts: row.alerts,
  sound: row.sound === 1,
});

export const remotePushTargets = {
  /** One row per phone, one phone per token. A re-paired phone's token moves to its new row. */
  set(db: Db, deviceId: string, registration: PushRegistration, at: number): void {
    db.stmt("INSERT OR REPLACE INTO remote_push_targets (device_id, token, environment, alerts, sound, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(
      deviceId,
      registration.token,
      registration.environment,
      registration.alerts,
      registration.sound ? 1 : 0,
      at,
    );
  },
  remove(db: Db, deviceId: string): void {
    db.stmt("DELETE FROM remote_push_targets WHERE device_id = ?").run(deviceId);
  },
  /** APNs said the token is dead. The phone registers again on its next session. */
  removeToken(db: Db, token: string): void {
    db.stmt("DELETE FROM remote_push_targets WHERE token = ?").run(token);
  },
  recipients(db: Db): PushRecipient[] {
    return (db.stmt(`${SELECT} ORDER BY d.created_at, d.id`).all() as unknown as Row[]).map(recipientOf);
  },
  /** One phone's registration as it stands now, or null once it is removed, turned off or its token moved. */
  recipient(db: Db, deviceId: string): PushRecipient | null {
    const row = db.stmt(`${SELECT} WHERE t.device_id = ?`).get(deviceId) as unknown as Row | undefined;
    return row ? recipientOf(row) : null;
  },
  count(db: Db): number {
    return (db.stmt("SELECT count(*) AS n FROM remote_push_targets").get() as { n: number }).n;
  },
};
