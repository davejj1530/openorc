import type { Db } from "./database.js";

export interface TeamNotificationReceipt {
  id: string;
  executionId: string;
  createdAt: number;
}

/** Receipts mean dispatched or deliberately suppressed, never confirmed OS delivery. */
export const teamNotifications = {
  has(db: Db, id: string): boolean {
    return Boolean(db.stmt("SELECT 1 FROM team_notification_receipts WHERE id = ?").get(id));
  },
  claim(db: Db, input: TeamNotificationReceipt): boolean {
    if (!input.id.trim() || input.id.length > 2000 || !Number.isSafeInteger(input.createdAt) || input.createdAt < 0) throw new Error("Invalid team notification receipt.");
    return db.transaction(() => {
      const previous = db.stmt("SELECT execution_id FROM team_notification_receipts WHERE id = ?").get(input.id) as { execution_id: string } | undefined;
      if (previous) {
        if (previous.execution_id !== input.executionId) throw new Error("This notification receipt belongs to another execution.");
        return false;
      }
      if (!db.stmt("SELECT 1 FROM team_executions WHERE id = ?").get(input.executionId)) throw new Error("Team notification execution not found.");
      db.stmt("INSERT INTO team_notification_receipts (id, execution_id, created_at) VALUES (?, ?, ?)").run(input.id, input.executionId, input.createdAt);
      return true;
    });
  },
};
