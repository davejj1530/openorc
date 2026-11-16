import type { HostedTerminal } from "@openorc/protocol";

/**
 * Which terminal each Terminal tab of a cloud thread shows, kept in this window's storage so a tab finds its terminal
 * again after the app opens anew. A tab is named by its shell (`main` for the first), as on this Mac.
 */
const KEY = "openorc.cloudTerminals";

type Claims = Record<string, Record<string, string>>;

function read(): Claims {
  try {
    return (JSON.parse(localStorage.getItem(KEY) ?? "{}") as Claims) ?? {};
  } catch {
    return {};
  }
}

export function claimTerminal(threadId: string, slot: string, terminalId: string): void {
  const all = read();
  all[threadId] = { ...all[threadId], [slot]: terminalId };
  localStorage.setItem(KEY, JSON.stringify(all));
}

/**
 * The terminal tab `slot` shows: the one it holds; else, for the first tab, the newest open one no other tab holds, or
 * the newest of any; else, for a later tab, an open one no other tab holds (a teammate's, to watch). Null when the tab
 * has none yet, and opens one if its reader may.
 */
export function terminalFor(threadId: string, slot: string, terminals: readonly HostedTerminal[]): HostedTerminal | null {
  const held = read()[threadId] ?? {};
  const own = held[slot] ? terminals.find((each) => each.id === held[slot]) : undefined;
  if (own) return own;
  const others = new Set(Object.entries(held).flatMap(([key, id]) => (key === slot ? [] : [id])));
  const free = terminals.filter((each) => !others.has(each.id));
  const open = free.find((each) => each.state !== "ended");
  if (slot === "main") return open ?? free[0] ?? null;
  return open ?? null;
}
