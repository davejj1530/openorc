import type { AgentCommand } from "../acp/profile.js";

/** Sessions OpenCode lists per page; a full page means there may be more. */
const PAGE = 200;
/** How deep subagents of subagents are followed. */
const DEPTH = 4;
/** How many listings run at once, each its own short OpenCode process. */
const AT_ONCE = 4;

interface Child {
  id: string;
  cost: number;
  /** When the session last changed; a subagent that has not changed has spawned nothing new either. */
  updated: number;
}

const record = (value: unknown): Record<string, unknown> => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const amount = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0);

/** One page of OpenCode's session list, as `opencode api session.list` prints it. */
function page(text: string): { children: Child[]; next: string | null } {
  const answer = record(JSON.parse(text));
  if (!Array.isArray(answer["data"])) throw new Error("OpenCode did not list the sessions.");
  const children = answer["data"].flatMap((value): Child[] => {
    const session = record(value);
    return typeof session["id"] === "string" ? [{ id: session["id"], cost: amount(session["cost"]), updated: amount(record(session["time"])["updated"]) }] : [];
  });
  const next = record(answer["cursor"])["next"];
  return { children, next: children.length === PAGE && typeof next === "string" ? next : null };
}

/** The sessions directly under one, every page of them. */
async function childrenOf(parentId: string, run: AgentCommand): Promise<Child[]> {
  const found: Child[] = [];
  let cursor: string | null = null;
  do {
    const listed = page(await run(["api", "--standalone", "session.list", "--param", `parentID=${parentId}`, "--param", `limit=${PAGE}`, ...(cursor ? ["--param", `cursor=${cursor}`] : [])]));
    found.push(...listed.children);
    cursor = listed.next;
  } while (cursor);
  return found;
}

async function inTurns<T, R>(items: T[], work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (let start = 0; start < items.length; start += AT_ONCE) results.push(...(await Promise.all(items.slice(start, start + AT_ONCE).map(work))));
  return results;
}

/**
 * What the subagents under an OpenCode session have cost, at every depth. OpenCode keeps each subagent's spend on the
 * subagent's own session, and the cost it reports for a session counts that session alone. A subagent that has not
 * changed since the last read keeps what was read under it, so a turn lists only the sessions it touched.
 */
export function openCodeSubagentCosts(run: AgentCommand): (sessionId: string) => Promise<number> {
  const below = new Map<string, { updated: number; cost: number }>();
  const costUnder = async (sessionId: string, depth: number): Promise<number> => {
    if (depth >= DEPTH) return 0;
    const costs = await inTurns(await childrenOf(sessionId, run), async (child) => {
      const kept = below.get(child.id);
      const under = kept && kept.updated === child.updated ? kept.cost : await costUnder(child.id, depth + 1);
      below.set(child.id, { updated: child.updated, cost: under });
      return child.cost + under;
    });
    return costs.reduce((sum, cost) => sum + cost, 0);
  };
  return (sessionId) => costUnder(sessionId, 0);
}
