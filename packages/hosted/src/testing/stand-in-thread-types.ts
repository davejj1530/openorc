/**
 * The stand-in's threads as it keeps them (stand-in-threads.ts): a seed to make one, its stored log, its messages and
 * asks, each reader's own view, and how a turn's settings are admitted.
 */
import type { UploadedFile } from "../wire-files.js";

export interface StandInThreadSeed {
  /** The id the app chose, as a fork's is; a new one otherwise. */ id?: string;
  projectId: string | null;
  title: string;
  createdAt?: string;
  status?: "idle" | "working" | "needs_answer";
  branch?: string;
  agent?: "claude" | "codex" | "opencode";
  backgroundCommands?: { id: string; description: string }[];
}

export interface Stored {
  seq: number;
  turnId: string | null;
  by: string | null;
  event: Record<string, unknown>;
}

/** Whether a person may start a turn with these settings, as billing and their sign-ins say; the refusal when not. */
export type Admit = (who: string, settings: { agent: string; model: string | null; accountId?: string | null }) => string | null;

export interface Message {
  id: string;
  author: string;
  text: string;
  state: "pending" | "delivered" | "refused" | "cancelled";
  refusal: string | null;
  after: boolean;
  createdAt: string;
  files: UploadedFile[];
  /** Paused by someone's Stop or a failed handoff: no turn takes it until its author starts it. */
  paused?: boolean;
  /** Why it waits paused, in the server's words; none for a Stop, which the server does not word yet. */
  pause?: { kind: string; message: string } | null;
  /** The task context it was sent with. */
  task?: { id: string; ifRevision: number } | null;
  /** The settings it was sent with; the turn it starts saves them as the thread's. */
  settings?: Partial<Thread["settings"]> & { agent?: string };
}

export interface Ask {
  id: string;
  kind: string;
  detail: string;
  answered: boolean;
  /** Its turn parked: answering it starts a turn. */
  parked: boolean;
  /** The turn that asked it. */
  turnId: string;
}

/** One reader's own view of a thread. */
export interface View {
  seenSeq: number;
  pinnedAt: string | null;
  archivedAt: string | null;
  snoozedUntil: string | null;
}

export interface Thread {
  id: string;
  space: string;
  owner: string;
  projectId: string | null;
  title: string;
  /** The thread a person started this one under; null for a thread of its own. */
  parentId?: string | null;
  branch: string;
  agent: string;
  status: string;
  views: Map<string, View>;
  /** `accountId`: which of its sender's accounts the next turn runs on, as a message or a change of settings named it. */
  settings: { model: string | null; effort: string | null; mode: string; permissionMode: string; accountId?: string | null };
  backgroundCommands: { id: string; description: string }[];
  stopped: string[];
  events: Stored[];
  messages: Message[];
  asks: Ask[];
  /** Who started the running turn; null between turns. */
  turn: string | null;
  /** The running turn, or the last one; each turn's sender by address; when the running one started. */
  turnId: string | null;
  turns: Map<string, string>;
  turnStartedAt: string | null;
  stopping: boolean;
  /** Who asked for the stop under way; null for none, or one the server made. */
  stoppedBy: string | null;
  createdAt: string;
  lastActivityAt: string;
}
