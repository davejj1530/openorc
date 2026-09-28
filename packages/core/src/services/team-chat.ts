import { roomAuthorKind, requestedChatDelivery, chatDeliveryState } from "./team-room-delivery.js";
import { createHash, randomUUID } from "node:crypto";
import { checkpoints, orchestration, projects, runs as runRows, teamRoom, teamRuntime, teamWorkspaces, threads } from "@openorc/db";
import { git } from "@openorc/git";
import {
  teamAttemptDirectionVersion,
  teamDiscussion,
  type TeamActorRecord,
  type TeamAttemptRecord,
  type TeamExecutionRecord,
  type TeamMailboxMessage,
  type TeamRoomDelivery,
  type TeamRoomEvent,
  type TeamRunBinding,
} from "@openorc/protocol";
import { teamContextExecutions } from "./team-context.js";
import { teamMentions } from "./team-mentions.js";
import { ROOM_BOOTSTRAP_EVENTS, TeamRoomService } from "./team-room.js";
import { moveActor, moveExecution } from "./team-states.js";
import { acceptsChat, activeClaims, assignmentsOf, conversant, errorText, idle, participantId, terminal, type ChatCore } from "./team-core.js";

/** An ambient turn's whole instruction: the room is context, only team_say is public. */
const AMBIENT_TURN = [
  "AMBIENT TURN: Nobody is waiting for your reply. You are reading the chat above because you follow this room or a colleague mentioned you.",
  "Decide whether you add something the team needs now: a correction, a risk only you see, an answer only you know. If so, call team_say with it, addressed to the colleagues it concerns or the lead.",
  "Otherwise end your turn with a short private note. Your final text is not shown to the team; only team_say is. Never create tasks, claim files or edit the workspace in an ambient turn.",
].join("\n");
/** Room messages settle for a moment before followers assess them, so a quick exchange is read whole. */
const AMBIENT_DEBOUNCE_MS = 300;
/** A follower reads a lively room no later than this after the first message it missed. */
const AMBIENT_MAX_WAIT_MS = 1500;
/** Workspace-relative file paths only; a claim never names anything outside the shared workspace. */
function claimPath(value: string): string {
  const trimmed = value.trim().replace(/^\.\//, "").replace(/\/+$/, "");
  if (!trimmed || trimmed.length > 4096 || trimmed.startsWith("/") || /^[A-Za-z]:[\\/]/.test(trimmed) || trimmed.split("/").some((segment) => segment === ".."))
    throw new Error(`Claim paths are relative to the team workspace: ${JSON.stringify(value)} is not.`);
  return trimmed;
}

/**
 * The team chat: who answers a message and who only reads it, ambient reads within their budget, file claims in the
 * shared workspace, the files each turn changed, and the member sessions kept open between turns. A finished
 * conversation's shared workspace is captured only once the room goes quiet.
 */
export class TeamChat {
  /**
   * Conversations whose lead has finished but whose shared workspace has not been captured yet. Members keep their
   * sessions and their share of the directory until the room actually goes quiet, and the execution is held open
   * until then, so it never reads as finished with no output recorded and a crash leaves it open for recovery.
   */
  private readonly captureOwed = new Set<string>();

  constructor(private readonly core: ChatCore) {}

  /**
   * Settles a conversation member's turn. An ambient read spoke only through team_say: its final text stays private
   * and it wakes nobody. Any other reply is chat. Returns whether the turn is fully settled here; the lead's own
   * outcome continues with its assignment rules.
   */
  settleTurn(state: TeamExecutionRecord, actor: TeamActorRecord, attempt: TeamAttemptRecord, runId: string, fresh: boolean): boolean {
    if (attempt.reason === "ambient") {
      attempt.outcome = teamRoom.spokeSince(this.core.db, state.instanceId, actor.id, attempt.createdAt) ? "public" : "silent";
      moveActor(actor, fresh ? "waiting" : "queued");
      actor.disposition = fresh ? idle(teamAttemptDirectionVersion(attempt)) : null;
      this.completeIfIdle(state);
      return true;
    }
    if (conversant(actor)) this.publishReply(state, actor, attempt, runId);
    if (!actor.participant) return false;
    moveActor(actor, fresh ? "waiting" : "queued");
    actor.disposition = fresh ? idle(teamAttemptDirectionVersion(attempt)) : null;
    this.completeIfIdle(state);
    return true;
  }

  /**
   * A member's reply is chat. Mentioning the lead asks it to act, so the lead is woken with the reply; a mentioned
   * colleague is woken to read it, owing nothing back; everyone else reads it as context next turn.
   */
  private publishReply(state: TeamExecutionRecord, actor: TeamActorRecord, attempt: TeamAttemptRecord, runId: string): void {
    const { db, room } = this.core;
    attempt.outcome = "public";
    const reply = runRows.get(db, runId)?.resultText ?? "";
    const revision = orchestration.getRevision(db, orchestration.getInstance(db, state.threadId)!.teamRevisionId)!;
    const mentioned = teamMentions(reply, revision.members);
    const targets = (
      mentioned.includes("all") ? state.actors.filter((item) => item.id === "lead" || item.participant).map((item) => item.id) : mentioned.map((key) => (key === "lead" ? "lead" : participantId(key)))
    ).filter((id) => id !== actor.id && state.actors.some((item) => item.id === id && acceptsChat(state, item)));
    const answerers = targets.filter((id) => id === "lead");
    const readers = targets.filter((id) => id !== "lead");
    const event = reply.trim()
      ? teamRoom.append(db, {
          instanceId: state.instanceId,
          authorKind: "member",
          authorId: actor.id,
          body: reply,
          addressees: targets,
          executionId: state.id,
          source: "reply",
          requestKey: `reply:${attempt.id}`,
          requestId: room.latestRequest(state.instanceId),
        })
      : null;
    if (answerers.length) {
      const chatId = randomUUID();
      for (const target of answerers)
        this.core.delivery.enqueueMessage(state, {
          senderId: actor.id,
          recipientId: target,
          kind: "chat",
          body: reply,
          dedupeKey: `chat:${actor.id}:reply:${attempt.id}:${target}`,
          attachments: [],
          chat: { chatId, to: targets, ...(event ? { roomEventId: event.id } : {}) },
        });
    }
    if (event) this.scheduleAmbient(state, event, [actor.id, ...answerers], readers);
  }

  /**
   * What a conversation member's turn reads from the room: exactly what its session has missed, minus what the
   * turn's own messages carry, with the shared workspace's claims and changes. Reserves that range as the turn's
   * room delivery, settled when the turn ends. A fresh session starts from a bounded slice of recent history.
   */
  turnInput(
    state: TeamExecutionRecord,
    actor: TeamActorRecord,
    messages: readonly TeamMailboxMessage[],
    options: { attemptId: string; freshSession: boolean; ambient: boolean },
  ): { chat: string; roomEvents: TeamRoomEvent[]; delivery: TeamRoomDelivery | null } {
    const { db, room } = this.core;
    const previous = teamRoom.cursor(db, state.instanceId, actor.id);
    // A fresh context is a new session epoch: it starts from a bounded slice of recent history rather than an unknown position.
    if (options.freshSession)
      teamRoom.setCursor(db, { instanceId: state.instanceId, actorId: actor.id, epoch: previous.epoch + 1, seq: Math.max(0, teamRoom.latestSeq(db, state.instanceId) - ROOM_BOOTSTRAP_EVENTS) });
    const cursor = teamRoom.cursor(db, state.instanceId, actor.id);
    const latest = teamRoom.latestSeq(db, state.instanceId);
    const carried = TeamRoomService.carried(messages);
    // The lead's instructions were its spec when they were given; a superseded one must not return as room context.
    if (actor.id === "lead") for (const id of [...teamRoom.openings(db, state.instanceId, state.id), ...teamRoom.leadInstructions(db, state.instanceId)]) carried.add(id);
    const roomEvents = room.pending(state.instanceId, actor.id, carried);
    const resentThrough = Math.max(
      0,
      ...teamRoom
        .deliveries(db, state.instanceId, { actorId: actor.id })
        .filter((item) => item.state === "uncertain")
        .map((item) => item.toSeq),
    );
    const delivery =
      latest > cursor.deliveredSeq
        ? teamRoom.reserveDelivery(db, {
            instanceId: state.instanceId,
            actorId: actor.id,
            epoch: cursor.epoch,
            fromSeq: cursor.deliveredSeq + 1,
            toSeq: latest,
            operation: "turn",
            attemptId: options.attemptId,
            state: "submitted",
          })
        : null;
    const chat = [room.input(state.instanceId, actor.id, roomEvents, { resentThrough }), this.workspaceContext(state, actor), options.ambient ? AMBIENT_TURN : ""].filter(Boolean).join("\n\n");
    return { chat, roomEvents, delivery };
  }

  /** Resolve "lead", "all" or member keys to conversation actors of this execution. */
  chatRecipients(record: TeamExecutionRecord, to: readonly string[], senderId: string): string[] {
    const ids = new Set<string>();
    for (const key of to) {
      if (key === "all" || key === "everyone") {
        for (const actor of record.actors) if (acceptsChat(record, actor)) ids.add(actor.id);
        continue;
      }
      const actor = record.actors.find((item) => conversant(item) && (key === "lead" ? item.id === "lead" : item.memberKey === key));
      if (!actor) throw new Error(`No team member is addressed by ${JSON.stringify(key)}. Use a member key from team_status, "lead" or "all".`);
      ids.add(actor.id);
    }
    ids.delete(senderId);
    return [...ids];
  }

  /**
   * One chat message, fanned out to each addressee. Whoever owes a reply is mailed: live where its provider accepts
   * input, queued otherwise. A member who already holds the user's request this message follows, or a peer past
   * the follow-up allowance, reads it instead: it is woken to read the room, and only team_say from that turn is public.
   */
  private postChat(
    executionId: string,
    sender: string,
    recipients: readonly string[],
    text: string,
    key: string,
    attachments: string[] = [],
    now = true,
  ): { chatId: string; delivered: { actorId: string; delivery: "sending" | "queued" | "accepted" | "delivered" | "unconfirmed" | "read" }[] } {
    this.core.assertAccepting();
    if (!text.trim() || text.length > 100_000 || !key.trim() || key.length > 200) throw new Error("Messages need bounded text and a request key.");
    if (!recipients.length) throw new Error("Address at least one member of the team.");
    const chatId = randomUUID();
    const { record, value } = teamRuntime.update(this.core.db, executionId, (state) => {
      this.core.assertGeneration(state, state.generation);
      const authorKind = roomAuthorKind(sender);
      const readers = this.readersOf(state, sender, recipients, key);
      const answerers = recipients.filter((recipient) => !readers.has(recipient));
      const event = teamRoom.append(this.core.db, {
        instanceId: state.instanceId,
        authorKind,
        authorId: sender,
        body: text,
        attachments,
        addressees: [...recipients],
        executionId: state.id,
        source: sender === "user" ? "chat" : "say",
        requestKey: `chat:${sender}:${key}`,
        ...(authorKind === "user" ? {} : { requestId: this.core.room.latestRequest(state.instanceId) }),
      });
      this.scheduleAmbient(state, event, [sender, ...answerers], [...readers]);
      return {
        readers,
        mailed: answerers.map((recipient) => {
          const dedupeKey = `chat:${sender}:${key}:${recipient}`;
          const previous = state.messages.find((message) => message.dedupeKey === dedupeKey);
          return this.core.delivery.enqueueMessage(state, {
            senderId: sender,
            recipientId: recipient,
            kind: "chat",
            body: text,
            dedupeKey,
            attachments,
            delivery: requestedChatDelivery(previous, now),
            chat: { chatId, to: [...recipients], roomEventId: event.id },
          });
        }),
      };
    });
    this.core.changed(record);
    const delivered = value.mailed.map((message) => {
      const fresh = message.chatId === chatId;
      if (now && fresh) this.core.delivery.deliverNow(executionId, message.id, message.recipientId);
      const current = this.core.status(executionId);
      const saved = current.messages.find((item) => item.id === message.id)!;
      const receipt = current.attempts.flatMap((attempt) => attempt.liveDirections ?? []).findLast((item) => item.messageId === message.id);
      const delivery = chatDeliveryState({ messageState: saved.state, receiptState: receipt?.state });
      return { actorId: message.recipientId, delivery };
    });
    this.core.scheduler.schedule();
    return { chatId: value.mailed[0]?.chatId ?? chatId, delivered: [...delivered, ...[...value.readers].map((actorId) => ({ actorId, delivery: "read" as const }))] };
  }

  /**
   * Which addressees of a colleague's message read it rather than answer it. The user's own messages and the lead
   * always get a reply turn. A member the user already addressed in the current request has that request to answer
   * and reads a colleague's relay of it; a peer's message past the follow-up allowance is read, so an exchange ends.
   */
  private readersOf(state: TeamExecutionRecord, sender: string, recipients: readonly string[], key: string): Set<string> {
    const readers = new Set<string>();
    if (sender === "user" || sender.startsWith("thread:")) return readers;
    const requestId = this.core.room.latestRequest(state.instanceId);
    const request = requestId ? teamRoom.get(this.core.db, requestId) : null;
    // Direction to the lead alone never enters the room; when it is the newest human input, nobody holds the current request yet.
    const superseded =
      request !== null &&
      state.messages.some((message) => message.kind === "direction" && (message.senderId === "user" || message.senderId.startsWith("thread:")) && message.createdAt >= request.createdAt);
    const discussion = teamDiscussion(orchestration.getRevision(this.core.db, orchestration.getInstance(this.core.db, state.threadId)!.teamRevisionId)!);
    for (const recipient of recipients) {
      if (recipient === "lead") continue;
      const holdsRequest = !superseded && (request?.addressees.includes(recipient) ?? false);
      if (holdsRequest || (sender !== "lead" && this.peerWakes(state, recipient, requestId, `chat:${sender}:${key}:`) > discussion.peerFollowUps)) readers.add(recipient);
    }
    return readers;
  }

  /** Reply turns a member owes to peers in one request: chat mailed to it by colleagues other than the lead, apart from the message being posted. */
  private peerWakes(state: TeamExecutionRecord, recipientId: string, requestId: string | null, ownKeyPrefix: string): number {
    return state.messages.filter(
      (message) =>
        message.kind === "chat" &&
        message.recipientId === recipientId &&
        message.senderId.startsWith("member:") &&
        !message.dedupeKey.startsWith(ownKeyPrefix) &&
        (message.roomEventId ? (teamRoom.get(this.core.db, message.roomEventId)?.requestId ?? null) : null) === requestId,
    ).length;
  }

  /** The user addresses members directly; unaddressed messages remain lead direction. */
  chat(executionId: string, input: { text: string; to: readonly string[]; requestKey: string; attachments?: string[]; now?: boolean }) {
    const record = this.core.status(executionId);
    return this.postChat(executionId, "user", this.chatRecipients(record, input.to, "user"), input.text, input.requestKey, input.attachments, input.now);
  }

  /** A member speaks in the chat: to named colleagues, to mentions, or to the lead by default. */
  say(runId: string, input: { text: string; to?: readonly string[]; requestKey?: string }) {
    const caller = this.core.actorFor(runId);
    if (caller.actor.id !== "lead" && !caller.actor.participant) throw new Error("Isolated assignments coordinate through team_message; team_say is for conversation members.");
    const revision = orchestration.getRevision(this.core.db, orchestration.getInstance(this.core.db, caller.record.threadId)!.teamRevisionId)!;
    const named = [...(input.to ?? []), ...teamMentions(input.text, revision.members)];
    const recipients = this.chatRecipients(caller.record, named.length ? named : ["lead"], caller.actor.id);
    if (!recipients.length) throw new Error("Address a colleague or the lead; a message to yourself is not delivered.");
    const key =
      input.requestKey ??
      createHash("sha256")
        .update(JSON.stringify([runId, input.text, recipients]))
        .digest("hex")
        .slice(0, 32);
    const posted = this.postChat(caller.record.id, caller.actor.id, recipients, input.text, key);
    const names = new Map(caller.record.actors.map((actor) => [actor.id, actor.id === "lead" ? "lead" : actor.memberKey]));
    return { posted: true, delivered: posted.delivered.map((item) => ({ member: names.get(item.actorId)!, delivery: item.delivery })) };
  }

  /** Advisory claims on shared-workspace files: colleagues see them and cannot claim the same path until it is released. */
  claim(
    runId: string,
    input: { paths: readonly string[]; note?: string; release?: boolean },
  ): { claims: { path: string; note: string | null }[]; held: { member: string; path: string; note: string | null }[] } {
    const caller = this.core.actorFor(runId);
    if (!input.paths.length || input.paths.length > 50) throw new Error("Claim between one and fifty files at a time.");
    const paths = [...new Set(input.paths.map(claimPath))];
    const note = input.note?.trim() ? input.note.trim().slice(0, 2000) : null;
    const { record } = teamRuntime.update(this.core.db, caller.record.id, (state) => {
      this.core.assertGeneration(state, caller.binding.generation);
      state.claims ??= [];
      const now = this.core.now();
      if (input.release) {
        for (const claim of state.claims) if (claim.actorId === caller.actor.id && claim.releasedAt === null && paths.includes(claim.path)) claim.releasedAt = now;
        return;
      }
      const held = activeClaims(state).filter((claim) => paths.includes(claim.path) && claim.actorId !== caller.actor.id);
      if (held.length)
        throw new Error(
          `${held.map((claim) => `${state.actors.find((actor) => actor.id === claim.actorId)?.input.title ?? claim.actorId} holds ${claim.path}`).join("; ")}. Ask in the chat or choose another file.`,
        );
      for (const path of paths)
        if (!activeClaims(state).some((claim) => claim.actorId === caller.actor.id && claim.path === path))
          state.claims.push({ id: randomUUID(), actorId: caller.actor.id, path, note, createdAt: now, releasedAt: null });
    });
    this.core.changed(record);
    const names = new Map(record.actors.map((actor) => [actor.id, actor.id === "lead" ? "lead" : actor.memberKey]));
    return {
      claims: activeClaims(record)
        .filter((claim) => claim.actorId === caller.actor.id)
        .map((claim) => ({ path: claim.path, note: claim.note })),
      held: activeClaims(record)
        .filter((claim) => claim.actorId !== caller.actor.id)
        .map((claim) => ({ member: names.get(claim.actorId)!, path: claim.path, note: claim.note })),
    };
  }

  /**
   * Captures a finished conversation's shared workspace, then lets it complete. The order matters: the execution is
   * still open while the capture runs, so Restore, Move, Fork and Delete are refused as they always were, and a crash
   * mid-capture leaves work to recover rather than a conversation that reads as finished with nothing recorded.
   */
  async captureRoom(settled: TeamExecutionRecord, generation: number): Promise<TeamExecutionRecord> {
    if (!this.captureOwed.has(settled.id) || !this.core.hooks.workspace) return settled;
    const current = this.core.status(settled.id);
    if (!["active", "attention"].includes(current.state) || current.generation !== generation || this.core.stopping.has(current.id) || !this.goneIdle(current)) return settled;
    let failure: string | null = null;
    try {
      // The members are idle by definition here, so their sessions go and the capture has the directory to itself.
      await this.closeWarmProcesses(current);
      await this.core.hooks.workspace.captureOutput(current.id, "lead", () => this.core.assertGeneration(this.core.status(current.id), generation));
    } catch (error) {
      failure = `Output capture needs attention: ${errorText(error)}`;
    }
    this.captureOwed.delete(settled.id);
    const saved = teamRuntime.update(this.core.db, settled.id, (state) => {
      if (state.generation !== generation || !["active", "attention"].includes(state.state)) return;
      const lead = state.actors.find((item) => item.id === "lead")!;
      // Work can be admitted while the capture runs, so what the lead had to finish is checked again after it.
      let problem = failure;
      const turn = state.attempts.findLast((item) => item.actorId === "lead");
      if (!problem && turn && this.core.hooks.tasks) {
        try {
          problem = this.core.hooks.tasks.completionReason(state, lead, turn) ?? null;
        } catch (error) {
          problem = `Task completion needs attention: ${errorText(error)}`;
        }
      }
      if (problem) this.core.attention(state, lead, problem);
      else this.completeIfIdle(state);
    }).record;
    this.core.changed(saved);
    return saved;
  }

  /** The lead finished while members may still be talking: its shared workspace is captured once the room goes quiet. */
  oweCapture(executionId: string): void {
    this.captureOwed.add(executionId);
  }
  capturePending(executionId: string): boolean {
    return this.captureOwed.has(executionId);
  }
  /** A stop or shutdown ends the conversation's sessions itself; nothing is captured on the way out. */
  dropCapture(executionId?: string): void {
    if (executionId === undefined) this.captureOwed.clear();
    else this.captureOwed.delete(executionId);
  }
  /** The capture a finished conversation owed its shared workspace is not lost with the process that owed it. */
  resumeCapture(record: TeamExecutionRecord): void {
    const lead = record.actors.find((item) => item.id === "lead")!;
    if (!["active", "attention"].includes(record.state) || lead.state !== "completed" || !record.actors.some((item) => item.participant) || !this.core.hooks.workspace) return;
    const workspace = teamWorkspaces.get(this.core.db, record.id, "lead");
    if (!workspace?.preparedTree || workspace.outputTree) return;
    this.captureOwed.add(record.id);
    this.core.track(this.captureRoom(record, record.generation).then(() => this.core.scheduler.schedule()));
  }

  /**
   * A new room message wakes the members who follow the room but were not part
   * of it, once their debounce runs out and within the revision's budget. Members
   * the message names without asking for a reply (`directed`) read it regardless.
   * Whoever is mid-turn reads it in the room slice of their next turn anyway.
   */
  scheduleAmbient(state: TeamExecutionRecord, event: TeamRoomEvent, involved: readonly string[], directed: readonly string[] = []): void {
    const instance = orchestration.getInstance(this.core.db, state.threadId)!;
    const discussion = teamDiscussion(orchestration.getRevision(this.core.db, instance.teamRevisionId)!);
    const requestId = event.requestId ?? event.id;
    const rounds = discussion.ambientRounds + (event.authorKind === "user" ? 0 : discussion.peerFollowUps);
    const now = this.core.now();
    for (const actor of state.actors) {
      if (!conversant(actor) || terminal(actor.state) || involved.includes(actor.id)) continue;
      // A member this message names reads it even when it only follows mentions, once beyond its unprompted reads,
      // and after the turn it is in the middle of; an unnamed follower mid-turn just finds it in its next room slice.
      const named = directed.includes(actor.id);
      if (!named && (actor.state !== "waiting" || discussion.mentionOnly.includes(actor.memberKey))) continue;
      const allowance = rounds + (named ? 1 : 0);
      const pendingSame = actor.ambient?.requestId === requestId;
      const used = state.attempts.filter((attempt) => attempt.actorId === actor.id && attempt.reason === "ambient" && attempt.roomRequestId === requestId).length + (pendingSame ? 1 : 0);
      if (used >= allowance) {
        if (pendingSame) actor.ambient = { ...actor.ambient!, throughSeq: event.seq };
        continue;
      }
      actor.ambient = actor.ambient
        ? { requestId, since: actor.ambient.since, dueAt: Math.min(now + AMBIENT_DEBOUNCE_MS, actor.ambient.since + AMBIENT_MAX_WAIT_MS), throughSeq: event.seq }
        : { requestId, since: now, dueAt: now + AMBIENT_DEBOUNCE_MS, throughSeq: event.seq };
    }
  }

  /**
   * Closes the sessions conversation members hold between turns. Their share of the workspace goes with them, which
   * is what an output capture, a fork, a restore or a move needs before it can touch the directory.
   */
  async closeWarmProcesses(record: TeamExecutionRecord): Promise<void> {
    const members = new Set(record.actors.filter((item) => item.participant).map((item) => item.id));
    // A process answering right now is not warm, whatever it was a moment ago; its turn is waited for, never cut off.
    const warm = this.core.turns.idleWarm(record.attempts.filter((item) => members.has(item.actorId)));
    for (const runId of warm) this.core.turns.cool(runId);
    // A session that refuses to close is reported by whatever needed the workspace; it must not fail the turn that asked.
    await Promise.all(warm.map((runId) => this.core.runs.closeAndWait(runId, this.core.hooks.closeTimeoutMs).catch(() => undefined)));
  }

  /** Whether nothing in this execution will run again without new input. */
  private goneIdle(state: TeamExecutionRecord): boolean {
    const busy = state.attempts.some((item) => ["starting", "running"].includes(item.state) || (item.state === "attention" && item.endedAt === null));
    const pending = state.messages.some((message) => message.state === "pending" || message.state === "claimed");
    // A lead that was never addressed in this execution has nothing to finish; a lead that ran and waits keeps the execution open.
    const lead = state.actors.find((item) => item.id === "lead")!;
    const leadIdle = lead.state === "waiting" && !state.attempts.some((item) => item.actorId === "lead" && item.reason !== "ambient");
    const reading = state.actors.some((item) => item.state === "waiting" && item.ambient);
    return (
      !busy &&
      !pending &&
      !reading &&
      assignmentsOf(state).every((item) => item.state === "completed" || (item === lead && leadIdle)) &&
      state.actors.every((item) => !item.participant || item.state === "waiting")
    );
  }

  /** The execution ends when every assignment is complete and every participant is idle with nothing left to read. */
  completeIfIdle(state: TeamExecutionRecord): void {
    const lead = state.actors.find((item) => item.id === "lead")!;
    const leadIdle = lead.state === "waiting" && !state.attempts.some((item) => item.actorId === "lead" && item.reason !== "ambient");
    // A conversation whose shared workspace is still to be captured stays open until it is; a terminal execution
    // cannot be reopened, so it must never become terminal while its output is missing.
    if (!this.goneIdle(state) || this.captureOwed.has(state.id)) return;
    for (const actor of state.actors)
      if (actor.participant || (actor === lead && leadIdle)) {
        moveActor(actor, "completed");
        actor.disposition = null;
      }
    for (const claim of activeClaims(state)) claim.releasedAt = this.core.now();
    moveExecution(state, "completed");
  }

  /** Which files a conversation member's turn changed in the shared workspace, from its checkpoint against the previous one. */
  async changedFiles(record: TeamExecutionRecord, binding: TeamRunBinding, snapshotId: string | null): Promise<string[] | undefined> {
    const actor = record.actors.find((item) => item.id === binding.actorId);
    if (!snapshotId || !actor || (actor.id !== "lead" && !actor.participant)) return undefined;
    const checkpoint = checkpoints.get(this.core.db, snapshotId);
    if (!checkpoint) return undefined;
    // A turn that changed nothing reuses the previous checkpoint, which belongs to another run.
    if (checkpoint.runId !== binding.runId) return [];
    const history = checkpoints.listForThread(this.core.db, record.threadId);
    const index = history.findIndex((item) => item.id === checkpoint.id);
    const thread = threads.get(this.core.db, record.threadId);
    const project = projects.get(this.core.db, record.projectId);
    if (!thread || !project) return undefined;
    // The first checkpoint of a conversation compares against what the lead workspace started from: its prepared tree, which
    // carries the checkout's uncommitted files, else the workspace's base commit, else HEAD.
    const base = index > 0 ? history[index - 1]!.treeSha : (this.leadStartTree(record) ?? (thread.baseSha ? `${thread.baseSha}^{tree}` : "HEAD^{tree}"));
    try {
      const diff = await git(thread.worktreePath ?? project.rootPath, ["diff-tree", "-r", "--name-only", base, checkpoint.treeSha]);
      return diff.stdout.split("\n").filter(Boolean).slice(0, 500);
    } catch {
      return undefined;
    }
  }

  /** The tree the conversation's first lead workspace was prepared from; later executions continue that workspace in place. */
  private leadStartTree(record: TeamExecutionRecord): string | null {
    const executions = [...teamContextExecutions(this.core.db, record.instanceId).filter((item) => item.id !== record.id), record].sort((a, b) => a.createdAt - b.createdAt);
    for (const execution of executions) {
      const workspace = teamWorkspaces.get(this.core.db, execution.id, "lead");
      if (workspace) return workspace.preparedTree ?? workspace.source.treeSha;
    }
    return null;
  }

  /** What a member must know about the shared workspace this turn: colleagues' claims, its own, and concurrent overlaps. */
  workspaceContext(state: TeamExecutionRecord, actor: TeamActorRecord): string {
    const history = [...teamContextExecutions(this.core.db, state.instanceId).filter((record) => record.id !== state.id), state];
    const names = this.core.room.names(state.instanceId);
    const sections: string[] = [];
    const claims = activeClaims(state).filter((claim) => claim.actorId !== actor.id);
    if (claims.length)
      sections.push(
        `Files colleagues currently hold in the shared workspace; do not edit them without asking in the chat:\n${claims.map((claim) => `- ${names(claim.actorId)}: ${claim.path}${claim.note ? ` (${claim.note})` : ""}`).join("\n")}`,
      );
    const mine = activeClaims(state).filter((claim) => claim.actorId === actor.id);
    if (mine.length) sections.push(`Files you hold: ${mine.map((claim) => claim.path).join(", ")}. Release them with team_claim when you are done.`);
    // Files colleagues changed since this member's last turn are workspace facts, not room messages.
    const since = Math.max(0, ...history.flatMap((record) => record.attempts.filter((item) => item.actorId === actor.id && item.state !== "starting").map((item) => item.createdAt)));
    const changed = history.flatMap((record) =>
      record.attempts
        .filter((attempt) => attempt.actorId !== actor.id && attempt.state === "closed" && attempt.changedFiles?.length && (attempt.endedAt ?? 0) >= since)
        .map(
          (attempt) =>
            `- ${names(attempt.actorId)} changed ${attempt.changedFiles!.slice(0, 20).join(", ")}${attempt.changedFiles!.length > 20 ? ` and ${attempt.changedFiles!.length - 20} more` : ""}`,
        ),
    );
    if (changed.length) sections.push(`Files colleagues changed in the shared workspace since your last turn:\n${changed.join("\n")}`);
    sections.push(...this.overlapWarnings(history, actor));
    return sections.join("\n\n");
  }

  /** Concurrent turns in one workspace can touch the same files; say so before the member continues. */
  private overlapWarnings(history: readonly TeamExecutionRecord[], actor: TeamActorRecord): string[] {
    const own = history
      .flatMap((record) => record.attempts)
      .filter((item) => item.actorId === actor.id && item.state === "closed" && item.changedFiles?.length)
      .at(-1);
    if (!own) return [];
    const overlaps = new Map<string, string[]>();
    for (const record of history)
      for (const other of record.attempts) {
        if (other.actorId === actor.id || !other.changedFiles?.length || other.createdAt >= (own.endedAt ?? Infinity) || (other.endedAt ?? Infinity) <= own.createdAt) continue;
        const shared = other.changedFiles.filter((file) => own.changedFiles!.includes(file));
        if (shared.length) overlaps.set(record.actors.find((item) => item.id === other.actorId)?.input.title ?? other.actorId, shared);
      }
    return [...overlaps].map(([who, files]) => `While you worked, ${who} also changed ${files.join(", ")}. Check those files before continuing.`);
  }
}
