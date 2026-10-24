import type { CorePush, Frame, RpcMethod, RpcParams, RpcResults } from "@openorc/protocol";

/** Something the core wants the person to know: a finished turn, an approval or question waiting, a failure. */
export type Notice = Omit<Extract<CorePush, { type: "notify" }>, "type">;

/** What a client hears from its core, in client terms. Each connection translates its own wire into these. */
export type ClientPush =
  | { type: "frame"; frame: Frame }
  | { type: "invalidate"; keys: string[] }
  | { type: "notify"; notice: Notice }
  /** A session with the core began. Resumed when one came before it, so pushes may have been missed in between. */
  | { type: "session"; resumed: boolean }
  /** Frames for these runs were dropped while the session stayed up. */
  | { type: "gap"; runIds: string[] };

/**
 * One line to a core, which the desktop's window port and the phone's link both are. Calls reach the core in the
 * order they were made, and an interest change reaches it before any call made after it. An `all` connection
 * delivers every run's frames; an `interest` one delivers only the frames of the runs last named.
 */
export interface CoreConnection {
  call<M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<RpcResults[M]>;
  onPush(listener: (push: ClientPush) => void): () => void;
  readonly delivery: "all" | "interest";
  setFrameInterest(runIds: ReadonlySet<string>): void;
}
