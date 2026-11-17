type Reply = { status: number; body: unknown };
type Reading = { agent: string; readAt: string; reading: unknown };

/** The server's readings of each person's agent sign-ins on OpenOrc Cloud (its agent-usage.ts), as a test sets them. */
export class StandInAgentUsage {
  /** Each person's readings, by who they are; none until a test sets some. Unserved, the route is missing, as on an older server. */
  readonly readings = new Map<string, Reading[]>();
  served = true;

  route(request: { method: string; path: string }, who: string): Reply | null {
    if (request.method !== "GET" || request.path !== "/hosted/usage" || !this.served) return null;
    return { status: 200, body: { agents: this.readings.get(who) ?? [] } };
  }
}
