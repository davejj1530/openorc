/** One socket of the stand-in's clients, as the server reaches it. */
export interface StandInPeer {
  /** The address the socket's token is for, or null once its session ended. */
  who(): string | null;
  watched: Set<string>;
  send(event: string, body: unknown): void;
  /** A message the server sends for the client to answer: the answer, or never when the client has nothing to say. */
  ask?(event: string, body: unknown): Promise<unknown>;
}
