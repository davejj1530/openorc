import { settledRoomDelivery } from "./team-room-delivery.js";
import { randomUUID } from "node:crypto";
import { audit, MAX_TEAM_MAILBOX_BYTES, MAX_TEAM_MESSAGES, teamRoom, teamRuntime, teamTaskCompletions, threads, runs as runRows } from "@openorc/db";
import {
  teamAttemptDirectionVersion,
  teamAttemptHasUnconfirmedDirection,
  teamAttemptMessageIds,
  type TeamRoomDelivery,
  type TeamActionAvailability,
  type TeamAttemptRecord,
  type TeamExecutionRecord,
  type TeamMailboxMessage,
} from "@openorc/protocol";
import { TeamRoomService } from "./team-room.js";
import { moveActor } from "./team-states.js";
import { terminal, errorText, acceptsChat, type DeliveryCore, type TeamExecutionRef } from "./team-core.js";

type DirectionInput = {
  executionId: string;
  senderId: string;
  recipientId: string;
  text: string;
  requestKey: string;
  generation: number;
  attachments?: string[];
  delivery?: "immediate";
};

type MailboxInput = {
  senderId: string;
  recipientId: string;
  kind: TeamMailboxMessage["kind"];
  body: string;
  dedupeKey: string;
  attachments?: string[];
  delivery?: "immediate";
  chat?: { chatId: string; to: string[]; roomEventId?: string };
};

/**
 * The durable mailbox and live steering: queued direction, results and chat rows, and their delivery into a
 * running turn one acknowledged request at a time. An uncertain delivery is never silently resent; a queued one
 * waits for the recipient's next turn. Cancellation and send-now apply only to input not yet reserved.
 */
export class TeamDelivery {
  constructor(private readonly core: DeliveryCore) {}

  /** The room delivery a turn carried ends with the turn; confirmation moves the member's cursor past what it read. */
  settleRoomDelivery(attempt: TeamAttemptRecord, state: "confirmed" | "uncertain" | "cancelled", error: string | null): void {
    const delivery = attempt.roomDeliveryId ? teamRoom.delivery(this.core.db, attempt.roomDeliveryId) : null;
    if (delivery && (delivery.state === "submitted" || delivery.state === "queued")) {
      teamRoom.settleDelivery(this.core.db, delivery.id, state, { error, assessed: state === "confirmed" });
    }
    // Provider acceptance alone is not a read. A successful turn also assesses
    // the live messages it accepted after its original input was reserved.
    if (state === "confirmed" && attempt.runId) {
      const binding = this.core.binding(attempt.runId);
      const record = binding ? this.core.status(binding.executionId) : null;
      if (record)
        for (const live of teamRoom.deliveries(this.core.db, record.instanceId, { attemptId: attempt.id })) {
          if (live.operation === "live" && live.state === "confirmed") teamRoom.advance(this.core.db, live.instanceId, live.actorId, live.toSeq, { assessed: true, epoch: live.epoch });
        }
    }
  }

  message(runId: string, input: { recipientId: string; text: string; requestKey: string }): TeamMailboxMessage {
    const caller = this.core.actorFor(runId);
    const recipient = caller.record.actors.find((actor) => actor.id === input.recipientId);
    if (!recipient || (recipient.parentId !== caller.actor.id && caller.actor.parentId !== recipient.id))
      throw new Error("Messages can address your parent or a direct assignment, within this execution.");
    const previous = caller.record.messages.find((message) => message.dedupeKey === `direction:${caller.actor.id}:${input.requestKey}`);
    const message = this.enqueueDirection({
      executionId: caller.record.id,
      senderId: caller.actor.id,
      recipientId: recipient.id,
      text: input.text,
      requestKey: input.requestKey,
      generation: caller.binding.generation,
      attachments: [],
      delivery: previous ? previous.delivery : "immediate",
    });
    if (!previous) this.deliverNow(caller.record.id, message.id, recipient.id);
    return this.core.status(caller.record.id).messages.find((item) => item.id === message.id)!;
  }

  /** Another thread of the same project addresses the lead; queued only, attributed by the sender thread. */
  messageFromThread(executionId: string, input: { sourceThreadId: string; body: string; requestKey: string }): TeamMailboxMessage {
    const record = this.core.status(executionId);
    if (!["active", "attention"].includes(record.state) || this.core.stopping.has(executionId))
      throw new Error("The team is not running right now. Its lead receives messages only during an execution.");
    return this.enqueueDirection({
      executionId,
      senderId: `thread:${input.sourceThreadId}`,
      recipientId: "lead",
      text: input.body,
      requestKey: input.requestKey,
      generation: record.generation,
    });
  }

  steer(executionId: string, input: { text: string; requestKey: string; attachments?: string[]; now?: boolean }): TeamMailboxMessage {
    const previous = this.core.status(executionId).messages.some((message) => message.dedupeKey === `direction:user:${input.requestKey}`);
    const message = this.enqueueDirection({
      executionId,
      senderId: "user",
      recipientId: "lead",
      text: input.text,
      requestKey: input.requestKey,
      generation: this.core.status(executionId).generation,
      attachments: input.attachments,
      delivery: input.now ? "immediate" : undefined,
    });
    // A response replay never upgrades queued delivery or repeats a wire send.
    if (input.now && !previous) this.deliverNow(executionId, message.id);
    return this.core.status(executionId).messages.find((item) => item.id === message.id)!;
  }

  steerAvailability(execution: TeamExecutionRef, actorId = "lead"): TeamActionAvailability {
    const deny = (reason: string) => ({ allowed: false, reason });
    if (this.core.closing) return deny("Team coordination is shutting down.");
    const record = this.core.recordOf(execution);
    if (!["active", "attention"].includes(record.state) || this.core.stopping.has(record.id) || record.deadlineAt <= this.core.now()) return deny("This execution cannot receive live direction.");
    const actor = record.actors.find((item) => item.id === actorId);
    if (!actor) return deny("This recipient is no longer available.");
    if (actor.state === "queued") {
      const capacity = this.core.scheduler.capacityReason(record, actor);
      if (capacity) return deny(capacity);
    }
    const who = actor.id === "lead" ? "The lead" : actor.input.title;
    const attempt = record.attempts.findLast((item) => item.actorId === actorId);
    if (
      actor.state !== "running" ||
      !attempt?.runId ||
      attempt.state !== "running" ||
      attempt.generation !== record.generation ||
      this.core.turns.isLaunching(attempt.id) ||
      this.core.turns.isSettling(attempt.id)
    )
      return deny(`${who} is ${actor.state === "starting" ? "starting" : "between turns"}. Direction will be queued.`);
    if (this.core.turns.delivery(attempt.runId) || teamAttemptHasUnconfirmedDirection(attempt)) return deny("Sending an earlier message first. Your message will follow in order.");
    if (runRows.get(this.core.db, attempt.runId)?.mode !== threads.get(this.core.db, record.threadId)?.mode) return deny("The selected mode applies to the next turn. Direction will be queued.");
    if (actor.disposition || teamTaskCompletions.intentsForAttempt(this.core.db, record.id, attempt.id).length) return deny(`${who} has already recorded its turn outcome. Direction will be queued.`);
    if (record.messages.some((message) => message.recipientId === actor.id && message.state === "claimed" && !teamAttemptMessageIds(attempt).includes(message.id)))
      return deny("Earlier delivery is unconfirmed. Recovery is required before sending again.");
    if (attempt.liveDirections?.some((receipt) => receipt.state === "unavailable")) return deny("This turn could not receive the message. It is queued for the next turn.");
    if (record.messages.some((message) => message.recipientId === actorId && message.kind === "result" && message.state === "pending"))
      return deny("Worker results require next-turn reconciliation. Your direction is retained with them.");
    const unavailable = this.core.runs.steerUnavailableReason(attempt.runId);
    if (unavailable) return deny(unavailable);
    return { allowed: true, reason: null };
  }

  /** Recheck durable live intent after startup, compaction, or an earlier acknowledgment. */
  providerReady(runId: string): void {
    if (this.core.binding(runId)) this.core.scheduler.schedule();
  }

  flushLiveDirection(executionId: string, actorId: string): void {
    const pending = this.core.status(executionId).messages.filter((message) => message.recipientId === actorId && message.state === "pending");
    const latest = pending.findLast((message) => message.delivery === "immediate" || message.sendNowAt !== undefined);
    if (latest) this.deliverNow(executionId, latest.id, actorId);
  }

  deliverNow(executionId: string, messageId: string, actorId = "lead"): void {
    const pending = this.core.status(executionId).messages.filter((message) => message.recipientId === actorId && message.state === "pending");
    const requested = pending.find((message) => message.id === messageId);
    if (!requested) return;
    // The durable immediate message is a watermark: promote its predecessors, one acknowledgment at a time.
    messageId = pending.filter((message) => message.sequence <= requested.sequence).sort((a, b) => a.sequence - b.sequence)[0]!.id;
    if (!this.steerAvailability(executionId, actorId).allowed) return;
    const { record, value: attempt } = teamRuntime.update(this.core.db, executionId, (state) => {
      const target = state.attempts.findLast((item) => item.actorId === actorId)!;
      const message = state.messages.find((item) => item.id === messageId)!;
      (target.liveDirections ??= []).push({
        messageId,
        directionVersion:
          state.actors.find((actor) => actor.id === actorId)!.directionVersion - state.messages.filter((item) => item.recipientId === actorId && item.sequence > message.sequence).length,
        state: "reserved",
        createdAt: this.core.now(),
        settledAt: null,
        error: null,
      });
      message.state = "claimed";
      message.attemptId = target.id;
      return target;
    });
    const runId = attempt.runId!;
    const operation = Promise.resolve()
      .then(async () => {
        let state: "accepted" | "unavailable" | "uncertain" = "uncertain";
        let error: string | null = null;
        let live: TeamRoomDelivery | null = null;
        try {
          const current = this.core.status(executionId);
          this.core.assertGeneration(current, attempt.generation);
          const message = current.messages.find((item) => item.id === messageId)!;
          this.core.runs.recordTeamDirection(runId, { id: message.id, text: message.body, attachments: message.attachments });
          const cursor = teamRoom.cursor(this.core.db, current.instanceId, actorId);
          const roomEvent = message.roomEventId ? teamRoom.get(this.core.db, message.roomEventId) : null;
          const latest = roomEvent?.seq ?? cursor.deliveredSeq;
          const carried = TeamRoomService.carried(current.messages.filter((item) => teamAttemptMessageIds(attempt).includes(item.id)));
          const events = message.kind === "chat" ? this.core.room.pending(current.instanceId, actorId, carried).filter((event) => event.seq <= latest) : [];
          live =
            latest > cursor.deliveredSeq && message.kind === "chat"
              ? teamRoom.reserveDelivery(this.core.db, {
                  instanceId: current.instanceId,
                  actorId,
                  epoch: cursor.epoch,
                  fromSeq: cursor.deliveredSeq + 1,
                  toSeq: latest,
                  operation: "live",
                  attemptId: attempt.id,
                  runId,
                  state: "submitted",
                })
              : null;
          const text = events.length ? this.core.room.input(current.instanceId, actorId, events, { requiredEventId: message.roomEventId }) : message.body;
          const attachments = [...new Set([...(message.attachments ?? []), ...events.flatMap((event) => event.attachments)])];
          state = await this.core.runs.steer(runId, text, attachments);
          if (state === "unavailable") error = "The provider turn ended or became unavailable before direction was sent. It remains queued.";
        } catch (failure) {
          error = `Live direction could not be confirmed: ${errorText(failure)}. Inspect the turn before explicitly retrying.`;
        }
        const current = this.core.status(executionId);
        if (current.generation !== attempt.generation || ["stopping", "stopped", "completed"].includes(current.state) || this.core.closing) {
          state = "uncertain";
          error = "The execution was stopped or replaced before live delivery could be confirmed.";
        }
        if (live && teamRoom.delivery(this.core.db, live.id)?.state === "submitted") teamRoom.settleDelivery(this.core.db, live.id, settledRoomDelivery(state), { error });
        const saved = teamRuntime.update(this.core.db, executionId, (execution) => {
          const target = execution.attempts.find((item) => item.id === attempt.id)!;
          const receipt = target.liveDirections!.find((item) => item.messageId === messageId)!;
          if (receipt.state !== "reserved") return;
          receipt.state = state;
          receipt.settledAt = Math.max(this.core.now(), receipt.createdAt);
          receipt.error = error;
          const message = execution.messages.find((item) => item.id === messageId)!;
          if (state === "unavailable") {
            message.state = "pending";
            message.attemptId = null;
          }
          if (execution.generation !== attempt.generation || ["stopping", "stopped", "completed"].includes(execution.state)) return;
          if (state === "accepted") execution.actors.find((actor) => actor.id === actorId)!.deliveredVersion = teamAttemptDirectionVersion(target);
          if (state === "uncertain")
            this.core.attention(
              execution,
              execution.actors.find((actor) => actor.id === actorId)!,
              error!,
            );
        }).record;
        this.core.changed(saved);
        if (state === "uncertain") {
          try {
            await this.core.runs.closeAndWait(runId, this.core.hooks.closeTimeoutMs);
          } catch (failure) {
            const failed = teamRuntime.update(this.core.db, executionId, (execution) => {
              if (execution.generation !== attempt.generation || ["stopping", "stopped", "completed"].includes(execution.state)) return;
              this.core.attention(
                execution,
                execution.actors.find((actor) => actor.id === actorId)!,
                `${error}\nWriter closure needs attention: ${errorText(failure)}`,
              );
            }).record;
            this.core.changed(failed);
          }
        }
      })
      .finally(() => {
        this.core.turns.delivered(runId);
        this.flushLiveDirection(executionId, actorId);
        this.core.hooks.changed(record.threadId);
      });
    this.core.turns.delivering(runId, operation);
    this.core.track(operation);
    this.core.changed(record);
  }

  steerActor(executionId: string, actorId: string, input: { text: string; requestKey: string; attachments?: string[] }): TeamMailboxMessage {
    this.core.assertAccepting();
    return this.enqueueDirection({
      executionId,
      senderId: "user",
      recipientId: actorId,
      text: input.text,
      requestKey: input.requestKey,
      generation: this.core.status(executionId).generation,
      attachments: input.attachments,
    });
  }

  cancelDirectionAvailability(execution: TeamExecutionRef, messageId: string): TeamActionAvailability {
    const deny = (reason: string) => ({ allowed: false, reason });
    if (this.core.closing) return deny("Team coordination is shutting down.");
    const record = this.core.recordOf(execution);
    if (record.state === "stopping" || this.core.stopping.has(record.id)) return deny("Wait for the team stop operation to finish before cancelling direction.");
    const message = record.messages.find((item) => item.id === messageId);
    if (!message || message.senderId !== "user" || message.kind !== "direction") return deny("Only a user direction in this execution can be cancelled.");
    if (message.state === "cancelled") return { allowed: true, reason: null };
    if (record.state === "completed") return deny("This execution is already complete.");
    if (
      message.state !== "pending" ||
      message.attemptId !== null ||
      record.attempts.some((attempt) => attempt.messageIds.includes(messageId) || attempt.liveDirections?.some((item) => item.messageId === messageId))
    )
      return deny("This direction was already reserved for an agent. Send a correction instead.");
    if (record.state === "stopped") {
      // A later fresh handoff can include this pending historical instruction
      // without claiming its old mailbox row. Do not promise to withdraw it once
      // a later lead reservation may have carried it into a provider session.
      if (teamRuntime.leadRanAfter(this.core.db, record.id)) return deny("Later work may already include this direction. Send a correction instead.");
    }
    return { allowed: true, reason: null };
  }

  /** A queued user direction can join the current turn after all, under the same rules as saying it now. */
  sendNowAvailability(execution: TeamExecutionRef, messageId: string): TeamActionAvailability {
    const deny = (reason: string) => ({ allowed: false, reason });
    const record = this.core.recordOf(execution);
    const message = record.messages.find((item) => item.id === messageId);
    if (!message || message.senderId !== "user" || message.kind !== "direction") return deny("Only your own queued direction can be sent now.");
    if (message.state !== "pending") return deny("This message is no longer waiting.");
    if (message.delivery === "immediate" || message.sendNowAt !== undefined) return deny("This message is already marked to go live.");
    return this.steerAvailability(record, message.recipientId);
  }

  /** The recorded delivery stays queued: history says how the message was sent, and separately that it was pushed live later. */
  sendNow(executionId: string, messageId: string): TeamMailboxMessage {
    const availability = this.sendNowAvailability(executionId, messageId);
    if (!availability.allowed) throw new Error(availability.reason!);
    const { record, value: recipientId } = teamRuntime.update(this.core.db, executionId, (state) => {
      const message = state.messages.find((item) => item.id === messageId)!;
      message.sendNowAt = Math.max(this.core.now(), message.createdAt);
      audit.record(this.core.db, { actor: "user", action: "team.direction.sendNow", resourceType: "thread", resourceId: state.threadId, metadata: { executionId, messageId } });
      return message.recipientId;
    });
    this.core.changed(record);
    this.deliverNow(executionId, messageId, recipientId);
    return this.core.status(executionId).messages.find((item) => item.id === messageId)!;
  }

  /** Cancel only before any reservation, including failed attempts that will retry. */
  cancelDirection(executionId: string, messageId: string): TeamMailboxMessage {
    const availability = this.cancelDirectionAvailability(executionId, messageId);
    if (!availability.allowed) throw new Error(availability.reason!);
    const previous = this.core.status(executionId).messages.find((message) => message.id === messageId)!;
    if (previous.state === "cancelled") return previous;
    const { record, value } = teamRuntime.update(this.core.db, executionId, (state) => {
      const message = state.messages.find((item) => item.id === messageId)!;
      message.state = "cancelled";
      message.cancelledAt = Math.max(this.core.now(), message.createdAt);
      audit.record(this.core.db, { actor: "user", action: "team.direction.cancel", resourceType: "thread", resourceId: state.threadId, metadata: { executionId, messageId } });
      return message;
    });
    // Existing reconciliation may already be queued, but cancellation itself
    // never starts another turn or rewinds the actor's monotonic version.
    this.core.changed(record);
    return value;
  }

  hasNewDirection(record: TeamExecutionRecord, attempt: TeamAttemptRecord): boolean {
    return (
      teamAttemptHasUnconfirmedDirection(attempt) ||
      record.messages.some((message) => message.recipientId === attempt.actorId && (message.state === "pending" || message.state === "claimed") && !teamAttemptMessageIds(attempt).includes(message.id))
    );
  }

  assertCurrentDirection(runId: string): void {
    const caller = this.core.actorFor(runId);
    if (this.hasNewDirection(caller.record, caller.attempt)) throw new Error("New direction has not been confirmed for this turn. Address it before completing.");
  }

  private enqueueDirection(input: DirectionInput): TeamMailboxMessage {
    this.core.assertAccepting();
    if (!input.text.trim() || input.text.length > 100_000 || !input.requestKey.trim() || input.requestKey.length > 200) throw new Error("Messages need bounded text and a request key.");
    const { record, value } = teamRuntime.update(this.core.db, input.executionId, (state) => {
      this.core.assertGeneration(state, input.generation);
      return this.enqueueMessage(state, {
        senderId: input.senderId,
        recipientId: input.recipientId,
        kind: "direction",
        body: input.text,
        dedupeKey: `direction:${input.senderId}:${input.requestKey}`,
        attachments: input.attachments,
        delivery: input.delivery,
      });
    });
    this.core.changed(record);
    this.core.scheduler.schedule();
    return value;
  }

  /** Mutate a journal record inside the caller's transaction; the caller persists and announces it. */
  enqueueMessage(record: TeamExecutionRecord, input: MailboxInput): TeamMailboxMessage {
    const { senderId, recipientId, kind, body, dedupeKey, attachments = [], delivery, chat } = input;
    if (attachments.length > 20 || attachments.some((file) => !file.trim() || file.length > 4096)) throw new Error("Messages accept up to 20 images with valid file references.");
    const normalized = [...new Set(attachments)];
    const existing = record.messages.find((message) => message.dedupeKey === dedupeKey);
    if (existing) {
      if (
        existing.recipientId !== recipientId ||
        existing.body !== body ||
        existing.kind !== kind ||
        existing.delivery !== delivery ||
        JSON.stringify(existing.attachments ?? []) !== JSON.stringify(normalized)
      )
        throw new Error("This message request key already identifies different direction.");
      return existing;
    }
    const recipient = record.actors.find((actor) => actor.id === recipientId);
    if (recipient?.state === "completed" && kind === "chat" && acceptsChat(record, recipient)) {
      moveActor(recipient, "queued");
      recipient.disposition = null;
    }
    if (!recipient || terminal(recipient.state)) throw new Error("This recipient no longer accepts messages.");
    const bytes = (text: string, images: string[]) => Buffer.byteLength(text) + images.reduce((total, file) => total + Buffer.byteLength(file), 0);
    if (
      record.messages.length >= MAX_TEAM_MESSAGES ||
      record.messages.reduce((total, message) => total + bytes(message.body, message.attachments ?? []), bytes(body, normalized)) > MAX_TEAM_MAILBOX_BYTES
    )
      throw new Error("This execution reached its mailbox limit. Review it before continuing.");
    const message: TeamMailboxMessage = {
      id: randomUUID(),
      sequence: (record.messages.at(-1)?.sequence ?? 0) + 1,
      senderId,
      recipientId,
      kind,
      body,
      dedupeKey,
      attachments: normalized,
      ...(delivery ? { delivery } : {}),
      ...(chat ? { chatId: chat.chatId, to: chat.to, ...(chat.roomEventId ? { roomEventId: chat.roomEventId } : {}) } : {}),
      state: "pending",
      attemptId: null,
      createdAt: this.core.now(),
      deliveredAt: null,
    };
    record.messages.push(message);
    recipient.directionVersion += 1;
    // Preserve this turn's intent. Freshness checks block completion while new
    // messages remain, and the scheduler wakes waiting actors for direction.
    // If unreserved direction is cancelled, the original intent remains valid.
    return message;
  }
}
