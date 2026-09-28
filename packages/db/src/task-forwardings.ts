import { TaskForwarding } from "@openorc/protocol";
import type { Db } from "./database.js";
import { settings } from "./memories.js";

const sourceKey = (id: string) => `task.forwarding.source.${id}`;
const targetKey = (id: string) => `task.forwarding.target.${id}`;
function read(db: Db, key: string): TaskForwarding | null {
  const value = settings.get(db, key);
  return value ? TaskForwarding.parse(JSON.parse(value)) : null;
}
export const taskForwardings = {
  source: (db: Db, id: string) => read(db, sourceKey(id)),
  target: (db: Db, id: string) => read(db, targetKey(id)),
  save(db: Db, record: TaskForwarding): void {
    const value = JSON.stringify(TaskForwarding.parse(record));
    db.transaction(() => {
      settings.set(db, sourceKey(record.sourceTaskId), value);
      settings.set(db, targetKey(record.targetTaskId), value);
    });
  },
};
