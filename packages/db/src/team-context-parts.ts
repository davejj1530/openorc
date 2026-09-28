import { createHash } from "node:crypto";
import type { Db } from "./database.js";

export interface TeamContextPart {
  instanceId: string;
  id: string;
  bytes: number;
  content: string;
  createdAt: number;
}
/** How a seed points at stored text: the part id plus enough to judge it without reading. */
export interface TeamContextReference {
  stored: string;
  bytes: number;
  preview: string;
}
interface PartRow {
  instance_id: string;
  id: string;
  bytes: number;
  content: string;
  created_at: number;
}

const PART_ID = /^[0-9a-f]{64}$/;
const decode = (row: PartRow): TeamContextPart => ({ instanceId: row.instance_id, id: row.id, bytes: row.bytes, content: row.content, createdAt: row.created_at });

/** Every stored id a seed or stored part refers to, at any depth. */
export function storedReferences(text: string): string[] {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return [];
  }
  const found = new Set<string>();
  const walk = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    const record = node as Record<string, unknown>;
    if (typeof record.stored === "string" && PART_ID.test(record.stored) && typeof record.bytes === "number") found.add(record.stored);
    Object.values(record).forEach(walk);
  };
  walk(value);
  return [...found];
}

/** Receipts embed seeds as JSON strings, so references there appear escaped; match ids textually as the schema does. */
function referencedAnywhere(text: string): string[] {
  return [...new Set([...text.matchAll(/"stored\\?":\\?"([0-9a-f]{64})\\?"/g)].map((match) => match[1]!))];
}

export const teamContextParts = {
  /** Content-addressed and idempotent: identical text stored twice is one row. */
  put(db: Db, instanceId: string, content: string): TeamContextPart {
    if (!content) throw new Error("Stored context text cannot be empty.");
    const id = createHash("sha256").update(content).digest("hex");
    return db.transaction(() => {
      db.stmt("INSERT OR IGNORE INTO team_context_parts(instance_id,id,bytes,content,created_at) VALUES(?,?,?,?,?)").run(instanceId, id, Buffer.byteLength(content), content, Date.now());
      const part = teamContextParts.get(db, instanceId, id)!;
      if (part.content !== content) throw new Error("Stored context text collided with different content.");
      return part;
    });
  },
  get(db: Db, instanceId: string, id: string): TeamContextPart | null {
    if (!PART_ID.test(id)) return null;
    const row = db.stmt("SELECT * FROM team_context_parts WHERE instance_id=? AND id=?").get(instanceId, id) as unknown as PartRow | undefined;
    return row ? decode(row) : null;
  },
  /** Removes parts nothing in the instance refers to any more; the schema refuses anything still referenced. */
  prune(db: Db, instanceId: string): string[] {
    return db.transaction(() => {
      const seeds = [
        ...db.stmt("SELECT seed AS text FROM team_context_checkpoints WHERE instance_id=?").all(instanceId),
        ...db.stmt("SELECT seed AS text FROM team_origins WHERE instance_id=?").all(instanceId),
        ...db.stmt("SELECT captured_input AS text FROM team_forks WHERE source_instance_id=?").all(instanceId),
        ...db.stmt("SELECT captured_input AS text FROM team_restores WHERE instance_id=?").all(instanceId),
        ...db.stmt("SELECT captured_input AS text FROM team_moves WHERE instance_id=?").all(instanceId),
        ...db.stmt("SELECT captured_input AS text FROM team_deletions WHERE instance_id=?").all(instanceId),
        // Everything an execution journal holds, as the retention trigger reads it.
        ...db
          .stmt(
            `SELECT COALESCE(e.error,'') AS text FROM team_executions e WHERE e.instance_id=?
            UNION ALL SELECT x.details FROM team_executions e JOIN team_actors x ON x.execution_id=e.id WHERE e.instance_id=?
            UNION ALL SELECT x.details FROM team_executions e JOIN team_attempts x ON x.execution_id=e.id WHERE e.instance_id=?
            UNION ALL SELECT x.prompt FROM team_executions e JOIN team_attempt_prompts x ON x.execution_id=e.id WHERE e.instance_id=?
            UNION ALL SELECT x.body || x.details FROM team_executions e JOIN team_messages x ON x.execution_id=e.id WHERE e.instance_id=?
            UNION ALL SELECT x.path || COALESCE(x.note,'') FROM team_executions e JOIN team_claims x ON x.execution_id=e.id WHERE e.instance_id=?`,
          )
          .all(instanceId, instanceId, instanceId, instanceId, instanceId, instanceId),
      ] as { text: string }[];
      const keep = new Set<string>();
      const queue = seeds.flatMap((seed) => referencedAnywhere(seed.text));
      while (queue.length) {
        const id = queue.shift()!;
        if (keep.has(id)) continue;
        keep.add(id);
        const part = teamContextParts.get(db, instanceId, id);
        if (part) queue.push(...referencedAnywhere(part.content));
      }
      const stored = (db.stmt("SELECT id FROM team_context_parts WHERE instance_id=? ORDER BY created_at, id").all(instanceId) as { id: string }[]).map((row) => row.id);
      const removed = stored.filter((id) => !keep.has(id));
      for (const id of removed) db.stmt("DELETE FROM team_context_parts WHERE instance_id=? AND id=?").run(instanceId, id);
      return removed;
    });
  },
  /** Copies the parts a seed references, and the parts those reference, so a fork owns its whole history. */
  adopt(db: Db, input: { from: string; to: string; seed: string }): string[] {
    return db.transaction(() => {
      const adopted: string[] = [];
      const queue = storedReferences(input.seed);
      while (queue.length) {
        const id = queue.shift()!;
        if (adopted.includes(id)) continue;
        const part = teamContextParts.get(db, input.from, id);
        if (!part) throw new Error("Fork context refers to stored text that its source no longer holds.");
        db.stmt("INSERT OR IGNORE INTO team_context_parts(instance_id,id,bytes,content,created_at) VALUES(?,?,?,?,?)").run(input.to, part.id, part.bytes, part.content, Date.now());
        adopted.push(id);
        queue.push(...storedReferences(part.content));
      }
      return adopted;
    });
  },
};
