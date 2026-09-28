/**
 * The team room: one append-only log of public messages per team instance,
 * each member's position in it, and each handing of a message range to a
 * member's session. Messages are immutable and numbered without gaps.
 */
export const teamRoomMigration = `
CREATE TABLE team_room_events (
  instance_id TEXT NOT NULL REFERENCES orchestration_team_instances(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL CHECK(seq>0),
  id TEXT NOT NULL UNIQUE,
  author_kind TEXT NOT NULL CHECK(author_kind IN ('user','member','thread')),
  author_id TEXT NOT NULL CHECK(length(author_id)>0),
  body TEXT NOT NULL,
  attachments TEXT NOT NULL CHECK(json_valid(attachments) AND json_type(attachments)='array'),
  addressees TEXT NOT NULL CHECK(json_valid(addressees) AND json_type(addressees)='array'),
  reply_to TEXT REFERENCES team_room_events(id),
  request_id TEXT,
  execution_id TEXT,
  source TEXT NOT NULL CHECK(source IN ('prompt','chat','say','reply','legacy')),
  request_key TEXT CHECK(request_key IS NULL OR length(request_key) BETWEEN 1 AND 200),
  payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64),
  created_at INTEGER NOT NULL CHECK(created_at>=0),
  PRIMARY KEY(instance_id,seq)
);
CREATE UNIQUE INDEX team_room_events_request ON team_room_events(instance_id,request_key) WHERE request_key IS NOT NULL;
CREATE TRIGGER team_room_event_sequence BEFORE INSERT ON team_room_events
WHEN NEW.seq<>(SELECT COALESCE(MAX(seq),0)+1 FROM team_room_events WHERE instance_id=NEW.instance_id)
BEGIN SELECT RAISE(ABORT,'Room messages are numbered without gaps.'); END;
CREATE TRIGGER team_room_event_immutable BEFORE UPDATE ON team_room_events
BEGIN SELECT RAISE(ABORT,'Room messages are immutable.'); END;
CREATE TABLE team_room_cursors (
  instance_id TEXT NOT NULL REFERENCES orchestration_team_instances(id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL CHECK(length(actor_id)>0),
  epoch INTEGER NOT NULL CHECK(epoch>=0),
  delivered_seq INTEGER NOT NULL CHECK(delivered_seq>=0),
  assessed_seq INTEGER NOT NULL CHECK(assessed_seq>=0 AND assessed_seq<=delivered_seq),
  unknown INTEGER NOT NULL CHECK(unknown IN (0,1)),
  updated_at INTEGER NOT NULL CHECK(updated_at>=0),
  PRIMARY KEY(instance_id,actor_id)
);
CREATE TABLE team_room_deliveries (
  id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL REFERENCES orchestration_team_instances(id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL CHECK(length(actor_id)>0),
  epoch INTEGER NOT NULL CHECK(epoch>=0),
  from_seq INTEGER NOT NULL CHECK(from_seq>0),
  to_seq INTEGER NOT NULL CHECK(to_seq>=from_seq),
  operation TEXT NOT NULL CHECK(operation IN ('turn','live')),
  attempt_id TEXT,
  run_id TEXT,
  state TEXT NOT NULL CHECK(state IN ('queued','submitted','confirmed','uncertain','cancelled')),
  error TEXT,
  created_at INTEGER NOT NULL CHECK(created_at>=0),
  settled_at INTEGER CHECK(settled_at IS NULL OR settled_at>=created_at)
);
CREATE INDEX team_room_deliveries_actor ON team_room_deliveries(instance_id,actor_id,created_at);
CREATE TRIGGER team_room_delivery_settled BEFORE UPDATE OF state ON team_room_deliveries
WHEN OLD.state IN ('confirmed','uncertain','cancelled')
BEGIN SELECT RAISE(ABORT,'A settled room delivery does not change.'); END;
`;
