import { randomUUID } from "node:crypto";
import type { Db } from "./database.js";

/** A phone paired for remote access. Its public key is its identity and its only credential. */
export interface RemoteDeviceRecord {
  id: string;
  name: string;
  publicKey: Uint8Array;
  createdAt: number;
  lastSeenAt: number | null;
}

interface Row {
  id: string;
  name: string;
  public_key: Uint8Array;
  created_at: number;
  last_seen_at: number | null;
}

const columns = "id, name, public_key, created_at, last_seen_at";
const record = (row: Row): RemoteDeviceRecord => ({ id: row.id, name: row.name, publicKey: new Uint8Array(row.public_key), createdAt: row.created_at, lastSeenAt: row.last_seen_at });

export const remoteDevices = {
  /** Pairing the same phone again keeps its row and id, and takes the name it gives now. */
  upsert(db: Db, input: { publicKey: Uint8Array; name: string; at: number }): RemoteDeviceRecord {
    const row = db
      .stmt(
        `INSERT INTO remote_devices (id, name, public_key, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(public_key) DO UPDATE SET name = excluded.name, last_seen_at = excluded.last_seen_at
         RETURNING ${columns}`,
      )
      .get(randomUUID(), input.name, input.publicKey, input.at, input.at) as unknown as Row;
    return record(row);
  },
  byKey(db: Db, publicKey: Uint8Array): RemoteDeviceRecord | null {
    const row = db.stmt(`SELECT ${columns} FROM remote_devices WHERE public_key = ?`).get(publicKey) as unknown as Row | undefined;
    return row ? record(row) : null;
  },
  list(db: Db): RemoteDeviceRecord[] {
    return (db.stmt(`SELECT ${columns} FROM remote_devices ORDER BY created_at, id`).all() as unknown as Row[]).map(record);
  },
  /** False when there was no such device. */
  remove(db: Db, id: string): boolean {
    return db.stmt("DELETE FROM remote_devices WHERE id = ?").run(id).changes > 0;
  },
  touch(db: Db, id: string, at: number): void {
    db.stmt("UPDATE remote_devices SET last_seen_at = ? WHERE id = ?").run(at, id);
  },
};
