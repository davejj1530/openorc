import { roomAuthorKind } from "./team-room-delivery.js";
import { orchestration, teamRoom, threads, runs as runRows, type Db } from "@openorc/db";
import type { TeamExecutionRecord, TeamRoomEvent } from "@openorc/protocol";
import { teamContextExecutions } from "./team-context.js";

/** How much history a session that starts fresh receives before incremental delivery takes over. */
export const ROOM_BOOTSTRAP_EVENTS = 40;
const MAX_ROOM_INPUT_BYTES = 48 * 1024;

export interface RoomNames {
  (actorId: string): string;
}

/**
 * The team room seen from the coordinator: who is who, what a member's session
 * has missed, and how those messages read as model input. Persistence is the
 * room log; the execution journal keeps only delivery intent per recipient.
 */
export class TeamRoomService {
  constructor(private readonly db: Db) {}

  /** Display names for authors and addressees, stable across executions. */
  names(instanceId: string): RoomNames {
    const instance = this.db.stmt("SELECT team_revision_id FROM orchestration_team_instances WHERE id=?").get(instanceId) as { team_revision_id: string } | undefined;
    const revision = instance ? orchestration.getRevision(this.db, instance.team_revision_id) : null;
    const members = new Map((revision?.members ?? []).map((member) => [member.key, member]));
    return (id: string) => {
      if (id === "user") return "User";
      if (id.startsWith("thread:")) return threads.get(this.db, id.slice("thread:".length))?.title ?? "Another thread";
      if (id === "lead") {
        const lead = [...members.values()].find((member) => member.managerKey === null);
        return lead ? `${lead.name} (lead)` : "Lead";
      }
      if (id.startsWith("member:")) return members.get(id.slice("member:".length))?.name ?? id.slice("member:".length);
      return id;
    };
  }

  /** Room messages a member's session has not been handed, excluding those its current turn already carries. */
  pending(instanceId: string, actorId: string, except: ReadonlySet<string> = new Set()): TeamRoomEvent[] {
    return teamRoom.pending(this.db, instanceId, actorId).filter((event) => !except.has(event.id));
  }

  /**
   * The one way room messages read as model input: numbered, attributed, with
   * addressees and attachments, bounded in bytes with the omission stated.
   */
  input(instanceId: string, actorId: string, events: readonly TeamRoomEvent[], options: { resentThrough?: number; requiredEventId?: string } = {}): string {
    if (events.length === 0) return "";
    const names = this.names(instanceId);
    const lines: string[] = [];
    let bytes = 0;
    let omitted = 0;
    for (const event of [...events].reverse()) {
      const line = this.line(event, actorId, names);
      bytes += Buffer.byteLength(line);
      if (bytes > MAX_ROOM_INPUT_BYTES && event.id !== options.requiredEventId) {
        omitted += 1;
        continue;
      }
      lines.unshift(line);
    }
    const first = events[0]!.seq,
      last = events[events.length - 1]!.seq;
    const resent = options.resentThrough !== undefined && events.some((event) => event.seq <= options.resentThrough!);
    return [
      `Team chat since your last turn (#${first}${last !== first ? ` to #${last}` : ""}), for context. Reply only to what is addressed to you or where you add something.` +
        (omitted ? ` ${omitted} earlier messages are omitted; read them with team_history.` : "") +
        (resent ? " Some of these were sent before and may have reached you already." : ""),
      ...lines,
    ].join("\n");
  }

  private line(event: TeamRoomEvent, actorId: string, names: RoomNames): string {
    const author = names(event.authorId);
    const body = event.body.split("\n").join("\n  ");
    const to = event.addressees.filter((id) => id !== event.authorId).map(names);
    const audience = roomAddress(event.source, to);
    const tag = event.addressees.includes(actorId) ? " (to you)" : "";
    const attachments = event.attachments.length ? `\n  attachments: ${event.attachments.join(", ")}` : "";
    return `- #${event.seq} ${author} ${audience}${tag}: ${body}${attachments}`;
  }

  /** History for the calling member: a page of the room in order, scoped to its own conversation. */
  history(instanceId: string, options: { afterSeq?: number; beforeSeq?: number; limit?: number }): { events: (TeamRoomEvent & { authorName: string; addresseeNames: string[] })[]; latestSeq: number } {
    const names = this.names(instanceId);
    const events = teamRoom.list(this.db, instanceId, { ...options, limit: Math.min(options.limit ?? 50, 200) });
    return { events: events.map((event) => ({ ...event, authorName: names(event.authorId), addresseeNames: event.addressees.map(names) })), latestSeq: teamRoom.latestSeq(this.db, instanceId) };
  }

  /**
   * Conversations that predate the room log get it rebuilt from their journals:
   * prompts, chat rows grouped by chat identity, and members' final replies, in
   * time order. Every member's cursor is then placed at the end and marked as
   * migrated: those sessions read the old transcript, but no delivery recorded it.
   */
  ensureMigrated(instanceId: string): void {
    if (teamRoom.count(this.db, instanceId) > 0) return;
    const executions = teamContextExecutions(this.db, instanceId);
    if (executions.length === 0) return;
    const entries: { at: number; order: number; append: () => void }[] = [];
    let order = 0;
    const actorIds = new Set<string>();
    for (const record of executions) {
      for (const actor of record.actors) if (actor.id === "lead" || actor.participant) actorIds.add(actor.id);
      const lead = record.actors.find((actor) => actor.id === "lead")!;
      const openingChat = record.messages.find(
        (message) => message.kind === "chat" && message.senderId === "user" && message.body === lead.input.spec && message.createdAt <= record.createdAt + 5_000,
      );
      if (!openingChat)
        entries.push({
          at: record.createdAt,
          order: order++,
          append: () => {
            teamRoom.append(this.db, {
              instanceId,
              authorKind: "user",
              authorId: "user",
              body: lead.input.spec,
              attachments: lead.input.attachments,
              addressees: ["lead"],
              executionId: record.id,
              source: "legacy",
              createdAt: record.createdAt,
            });
          },
        });
      const seen = new Set<string>();
      for (const message of record.messages) {
        if (message.kind !== "chat" || message.state === "cancelled") continue;
        const identity = message.chatId ?? message.id;
        if (seen.has(identity)) continue;
        seen.add(identity);
        const kind = roomAuthorKind(message.senderId);
        entries.push({
          at: message.createdAt,
          order: order++,
          append: () => {
            teamRoom.append(this.db, {
              instanceId,
              authorKind: kind,
              authorId: message.senderId,
              body: message.body,
              attachments: message.attachments ?? [],
              addressees: message.to ?? [message.recipientId],
              executionId: record.id,
              source: "legacy",
              createdAt: message.createdAt,
            });
          },
        });
      }
      for (const attempt of record.attempts) {
        const speaker = record.actors.find((actor) => actor.id === attempt.actorId);
        if (!speaker || (speaker.id !== "lead" && !speaker.participant) || attempt.state !== "closed" || !attempt.runId) continue;
        const reply = runRows.get(this.db, attempt.runId)?.resultText?.trim();
        if (!reply) continue;
        const at = attempt.endedAt ?? attempt.createdAt;
        entries.push({
          at,
          order: order++,
          append: () => {
            teamRoom.append(this.db, { instanceId, authorKind: "member", authorId: speaker.id, body: reply, executionId: record.id, source: "legacy", createdAt: at });
          },
        });
      }
    }
    this.db.transaction(() => {
      for (const entry of entries.sort((a, b) => a.at - b.at || a.order - b.order)) entry.append();
      const latest = teamRoom.latestSeq(this.db, instanceId);
      for (const actorId of actorIds) teamRoom.setCursor(this.db, { instanceId, actorId, epoch: 0, seq: latest, unknown: true });
    });
  }

  /** The most recent human message: what a member's contribution answers or follows. */
  latestRequest(instanceId: string): string | null {
    const row = this.db.stmt("SELECT id FROM team_room_events WHERE instance_id=? AND author_kind='user' ORDER BY seq DESC LIMIT 1").get(instanceId) as { id: string } | undefined;
    return row?.id ?? null;
  }

  /** Whether a journal message hands over a room message this turn already carries. */
  static carried(messages: readonly { roomEventId?: string }[]): Set<string> {
    return new Set(messages.flatMap((message) => (message.roomEventId ? [message.roomEventId] : [])));
  }

  /** The execution's conversation actors, for addressing. */
  static members(record: TeamExecutionRecord): string[] {
    return record.actors.filter((actor) => actor.id === "lead" || actor.participant).map((actor) => actor.id);
  }
}

function roomAddress(source: TeamRoomEvent["source"], to: readonly string[]): string {
  if (source === "reply" && !to.length) return "said";
  if (to.length) return `to ${to.join(", ")}`;
  return "to the room";
}
