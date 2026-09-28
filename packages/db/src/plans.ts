import { randomUUID } from "node:crypto";
import type { AgentEvent, ConversationPlan, Run } from "@openorc/protocol";
import type { Db } from "./database.js";
import { teamRuntime } from "./team-runtime.js";

const columns = `id, thread_id AS threadId, run_id AS runId, revision, text, state, source, updated_at AS updatedAt`;
const MAX_PLAN = 1_000_000;
export const plans = {
  recover(db: Db): void {
    db.stmt("UPDATE conversation_plans SET state='interrupted' WHERE state='draft'").run();
  },
  list(db: Db, threadId: string): ConversationPlan[] {
    // Older Codex turns copied discussion into response plans. Keep the stored
    // records, but don't offer those copies as plans to view or implement.
    return db
      .stmt(
        `SELECT ${columns} FROM conversation_plans WHERE thread_id=?
        AND NOT (source='response' AND run_id IN (SELECT id FROM runs WHERE agent='codex'))
        AND NOT EXISTS (SELECT 1 FROM team_run_bindings b WHERE b.run_id=conversation_plans.run_id AND (b.actor_id!='lead' OR source!='native'))
        ORDER BY revision DESC`,
      )
      .all(threadId) as unknown as ConversationPlan[];
  },
  /** Only provider document events or the final response of a Plan turn become plan revisions. */
  capture(db: Db, run: Run, event: AgentEvent): boolean {
    if (!run.threadId || run.mode !== "plan") return false;
    const team = teamRuntime.binding(db, run.id);
    // Member proposals remain in their attributed transcript; only the lead
    // publishes the team's shared plan, through an explicit document event.
    if (team && team.actorId !== "lead") return false;
    if (event.type === "turn.started") {
      db.stmt("INSERT INTO conversation_plan_turns(run_id,started_at) VALUES(?,?) ON CONFLICT(run_id) DO UPDATE SET started_at=excluded.started_at, native_document=0").run(run.id, event.ts);
      return false;
    }
    const turn = db.stmt("SELECT started_at, native_document FROM conversation_plan_turns WHERE run_id=?").get(run.id) as { started_at: number; native_document: number } | undefined;
    const since = turn?.started_at ?? run.startedAt;
    const hasNative = () => Boolean(turn?.native_document) || Boolean(db.stmt("SELECT 1 FROM conversation_plans WHERE run_id=? AND source='native' AND updated_at>=?").get(run.id, since));
    if (event.type === "turn.completed" || event.type === "session.completed") {
      const success = event.type === "turn.completed" && event.status === "success";
      if (event.type === "turn.completed" && run.agent !== "codex" && !team) {
        const native = hasNative();
        const preview = db.stmt(`SELECT ${columns} FROM conversation_plans WHERE run_id=? AND source='response' AND state='draft' ORDER BY revision DESC LIMIT 1`).get(run.id) as unknown as
          ConversationPlan | undefined;
        const text = event.resultText?.trim() || preview?.text;
        if (success && text && !native) {
          db.stmt("DELETE FROM conversation_plans WHERE run_id=? AND source='response' AND state='draft'").run(run.id);
          plans.write(db, run, `response:${event.turnId ?? event.ts}`, text, "response", true, event.ts);
        }
      }
      db.stmt("UPDATE conversation_plans SET state=?, updated_at=? WHERE run_id=? AND state='draft'").run(success ? "ready" : "interrupted", event.ts, run.id);
      return true;
    }
    if ((event.type === "message.delta" || event.type === "message.completed") && event.role === "assistant") {
      if (run.agent === "codex" || team) return false;
      if (hasNative()) return false;
      const documentId = `response:${event.messageId}`;
      const previous = db.stmt("SELECT text FROM conversation_plans WHERE run_id=? AND document_id=? AND state='draft'").get(run.id, documentId) as { text: string } | undefined;
      const text = event.type === "message.delta" ? (previous?.text ?? "") + event.text : event.text;
      plans.write(db, run, documentId, text, "response", false, event.ts);
      return true;
    }
    if (event.type !== "plan.updated") return false;
    db.stmt("INSERT INTO conversation_plan_turns(run_id,started_at,native_document) VALUES(?,?,1) ON CONFLICT(run_id) DO UPDATE SET native_document=1").run(run.id, since);
    db.stmt("DELETE FROM conversation_plans WHERE run_id=? AND source='response' AND state='draft'").run(run.id);
    const previous = db.stmt(`SELECT ${columns} FROM conversation_plans WHERE run_id=? AND document_id=? ORDER BY revision DESC LIMIT 1`).get(run.id, event.documentId) as unknown as
      ConversationPlan | undefined;
    const text = event.delta ? (previous?.text ?? "") + event.text : event.text;
    if (text.length > MAX_PLAN) throw new Error("The proposed plan exceeds the 1 MB document limit.");
    plans.write(db, run, event.documentId, text, "native", event.complete ?? false, event.ts);
    return true;
  },
  write(db: Db, run: Run, documentId: string, text: string, source: ConversationPlan["source"], complete: boolean, at: number): void {
    if (!run.threadId || text.length > MAX_PLAN) return;
    db.transaction(() => {
      const previous = db.stmt(`SELECT ${columns} FROM conversation_plans WHERE run_id=? AND document_id=? ORDER BY revision DESC LIMIT 1`).get(run.id, documentId) as unknown as
        ConversationPlan | undefined;
      if (previous?.state === "draft") {
        db.stmt("UPDATE conversation_plans SET text=?, state=?, updated_at=? WHERE id=?").run(text, complete ? "ready" : "draft", at, previous.id);
        return;
      }
      if (previous?.text === text) return;
      const row = db.stmt("SELECT COALESCE(MAX(revision),0)+1 AS revision FROM conversation_plans WHERE thread_id=?").get(run.threadId!) as { revision: number };
      db.stmt("INSERT INTO conversation_plans(id,thread_id,run_id,document_id,revision,text,state,source,updated_at) VALUES(?,?,?,?,?,?,?,?,?)").run(
        randomUUID(),
        run.threadId!,
        run.id,
        documentId,
        row.revision,
        text,
        complete ? "ready" : "draft",
        source,
        at,
      );
    });
  },
};
