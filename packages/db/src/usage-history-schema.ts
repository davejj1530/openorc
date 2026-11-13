const body = "COALESCE(a.content, e.payload)";
const accountingRows = `
  SELECT e.id, e.run_id, e.ts, e.kind, json_extract(${body}, '$.usage')
  FROM events e LEFT JOIN artifacts a ON a.event_id = e.id AND a.kind = 'payload'
  WHERE e.kind IN ('turn.completed', 'usage.updated') AND json_valid(${body})`;

/** Compact accounting survives restarts and follows every ledger writer, including imported events. */
export const usageHistoryMigration = `
  CREATE TABLE usage_reports (
    event_id INTEGER PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
    run_id TEXT NOT NULL,
    ts INTEGER NOT NULL,
    kind TEXT NOT NULL,
    usage TEXT
  );
  CREATE INDEX usage_reports_run ON usage_reports(run_id, ts, event_id);
  INSERT INTO usage_reports ${accountingRows};

  CREATE TRIGGER usage_reports_event_insert AFTER INSERT ON events
  WHEN NEW.kind IN ('turn.completed', 'usage.updated') BEGIN
    INSERT OR REPLACE INTO usage_reports ${accountingRows} AND e.id = NEW.id;
  END;

  CREATE TRIGGER usage_reports_event_update AFTER UPDATE OF run_id, ts, kind, payload ON events
  WHEN OLD.kind IN ('turn.completed', 'usage.updated') OR NEW.kind IN ('turn.completed', 'usage.updated') BEGIN
    DELETE FROM usage_reports WHERE event_id = OLD.id;
    INSERT OR REPLACE INTO usage_reports ${accountingRows} AND e.id = NEW.id;
  END;

  CREATE TRIGGER usage_reports_event_delete AFTER DELETE ON events
  WHEN OLD.kind IN ('turn.completed', 'usage.updated') BEGIN
    DELETE FROM usage_reports WHERE event_id = OLD.id;
  END;

  CREATE TRIGGER usage_reports_artifact_insert AFTER INSERT ON artifacts WHEN NEW.kind = 'payload' BEGIN
    DELETE FROM usage_reports WHERE event_id = NEW.event_id;
    INSERT OR REPLACE INTO usage_reports ${accountingRows} AND e.id = NEW.event_id;
  END;

  CREATE TRIGGER usage_reports_artifact_update AFTER UPDATE OF event_id, kind, content ON artifacts
  WHEN OLD.kind = 'payload' OR NEW.kind = 'payload' BEGIN
    DELETE FROM usage_reports WHERE event_id IN (OLD.event_id, NEW.event_id);
    INSERT OR REPLACE INTO usage_reports ${accountingRows} AND e.id IN (OLD.event_id, NEW.event_id);
  END;

  CREATE TRIGGER usage_reports_artifact_delete AFTER DELETE ON artifacts WHEN OLD.kind = 'payload' BEGIN
    DELETE FROM usage_reports WHERE event_id = OLD.event_id;
    INSERT OR REPLACE INTO usage_reports ${accountingRows} AND e.id = OLD.event_id;
  END;
`;
