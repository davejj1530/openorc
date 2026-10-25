/** A paired phone that asked for alerts. Removing the phone removes this row. */
export const remotePushTargetMigration = `
CREATE TABLE remote_push_targets (
  device_id TEXT PRIMARY KEY REFERENCES remote_devices(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  environment TEXT NOT NULL CHECK (environment IN ('sandbox', 'production')),
  alerts TEXT NOT NULL CHECK (alerts IN ('all', 'needs-you')),
  sound INTEGER NOT NULL CHECK (sound IN (0, 1)),
  updated_at INTEGER NOT NULL
);
`;
