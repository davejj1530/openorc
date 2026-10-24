/** Phones paired for remote access. A device is its public key; nothing secret is stored. */
export const remoteDeviceMigration = `
CREATE TABLE remote_devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  public_key BLOB NOT NULL UNIQUE CHECK(length(public_key) = 32),
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER
);
`;
