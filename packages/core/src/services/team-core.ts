import { createHash } from "node:crypto";
import type { Db } from "@openorc/db";
import type { Run, TeamActorRecord, TeamAttemptRecord, TeamExecutionRecord, TeamRunBinding } from "@openorc/protocol";
import type { RunService } from "./runs.js";
import type { TeamAssignments } from "./team-assignments.js";
import type { TeamChat } from "./team-chat.js";
import type { TeamCoordinatorHooks } from "./team-coordinator.js";
import type { TeamDelivery } from "./team-delivery.js";
import type { TeamRoomService } from "./team-room.js";
import type { TeamScheduler } from "./team-scheduler.js";
import type { TeamTurns } from "./team-turns.js";

/**
 * What the coordinator's parts share: its services, its lifecycle checks, and each other. TeamCoordinator implements
 * it and is the only thing that constructs the parts, so each part owns one concern and reaches the rest through here.
 */
export interface TeamCore {
  readonly db: Db;
  readonly runs: RunService;
  readonly hooks: TeamCoordinatorHooks;
  readonly room: TeamRoomService;
  readonly turns: TeamTurns;
  readonly closing: boolean;
  readonly stopping: ReadonlyMap<string, Promise<void>>;
  readonly delivery: TeamDelivery;
  readonly teamChat: TeamChat;
  readonly assignments: TeamAssignments;
  readonly scheduler: TeamScheduler;
  now(): number;
  status(executionId: string): TeamExecutionRecord;
  /** The journal a caller already read, or the current one by id. */
  recordOf(execution: TeamExecutionRef): TeamExecutionRecord;
  binding(runId: string): TeamRunBinding | null;
  actorFor(runId: string): TeamCaller;
  changed(record: TeamExecutionRecord): void;
  track(operation: Promise<void>): void;
  assertAccepting(): void;
  assertGeneration(record: TeamExecutionRecord, generation: number): void;
  attention(record: TeamExecutionRecord, actor: TeamActorRecord, error: string): void;
  launch(executionId: string, actorId: string): void;
  stop(executionId: string): Promise<void>;
}

/** Each collaborator sees only the coordinator capabilities it uses; the coordinator remains the journal owner. */
type CollaboratorCore<Capability extends keyof TeamCore, Hook extends keyof TeamCoordinatorHooks> = Omit<Pick<TeamCore, Capability>, "hooks"> & {
  readonly hooks: Pick<TeamCoordinatorHooks, Hook>;
};

export type AssignmentCore = CollaboratorCore<
  "db" | "runs" | "turns" | "stopping" | "delivery" | "scheduler" | "status" | "actorFor" | "changed" | "assertGeneration" | "attention",
  "tasks" | "workspace"
>;
export type ChatCore = CollaboratorCore<
  "db" | "runs" | "room" | "turns" | "stopping" | "delivery" | "scheduler" | "now" | "status" | "actorFor" | "changed" | "track" | "assertAccepting" | "assertGeneration" | "attention",
  "tasks" | "workspace" | "closeTimeoutMs"
>;
export type DeliveryCore = CollaboratorCore<
  | "db"
  | "runs"
  | "room"
  | "turns"
  | "closing"
  | "stopping"
  | "scheduler"
  | "now"
  | "status"
  | "recordOf"
  | "binding"
  | "actorFor"
  | "changed"
  | "track"
  | "assertAccepting"
  | "assertGeneration"
  | "attention",
  "changed" | "closeTimeoutMs"
>;
export type SchedulerCore = CollaboratorCore<
  "db" | "runs" | "turns" | "closing" | "delivery" | "now" | "status" | "changed" | "track" | "attention" | "launch" | "stop",
  "changed" | "warn" | "providerLimits" | "workspace"
>;

/** An execution by id, or its journal as the caller already read it, so a view built from one read checks against it. */
export type TeamExecutionRef = string | TeamExecutionRecord;

/** A team run calling a tool, resolved from its immutable binding: authority never comes from a supplied actor id. */
export interface TeamCaller {
  binding: TeamRunBinding;
  record: TeamExecutionRecord;
  actor: TeamActorRecord;
  attempt: TeamAttemptRecord;
  run: Run;
}

export const terminal = (state: TeamActorRecord["state"]) => state === "completed" || state === "cancelled";
/** Isolated assignments plus the lead; participants are conversation members, never required work. */
export const assignmentsOf = (record: TeamExecutionRecord) => record.actors.filter((actor) => !actor.participant);
export const participantId = (memberKey: string) => `member:${memberKey}`;
export const idle = (version: number): TeamActorRecord["disposition"] => ({ kind: "wait", version, waitFor: [], result: null });
export const activeClaims = (record: TeamExecutionRecord) => (record.claims ?? []).filter((claim) => claim.releasedAt === null);
export const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
export const hash = (input: unknown) => createHash("sha256").update(JSON.stringify(input)).digest("hex");
export const conversant = (actor: TeamActorRecord) => actor.id === "lead" || actor.participant === true;
/** Finishing the lead's reply does not close its inbox while colleagues are still talking. */
export const acceptsChat = (record: TeamExecutionRecord, actor: TeamActorRecord) =>
  conversant(actor) && (record.state === "active" || record.state === "attention") && (!terminal(actor.state) || (actor.id === "lead" && actor.state === "completed"));
