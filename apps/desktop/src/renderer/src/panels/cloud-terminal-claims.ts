import { panelToolLabels } from "@openorc/client";
import type { HostedTerminal } from "@openorc/protocol";
import type { TerminalShell } from "../lib/panel-tabs";

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

/**
 * What the thread's terminals are called beside its conversation: each by the name of the Terminal tab that shows it
 * here (`shells`, the shell of each, null for the first), and one no tab here shows by the next name no tab has, so no
 * two read alike.
 */
export function terminalNames(threadId: string, shells: readonly (TerminalShell | null)[], terminalIds: readonly string[]): Map<string, string> {
  const held = read()[threadId] ?? {};
  const names = new Map<string, string>();
  const taken = new Set<number>();
  for (const shell of shells) {
    const number = shell?.number ?? 1;
    taken.add(number);
    const id = held[shell?.id ?? "main"];
    if (id && terminalIds.includes(id)) names.set(id, terminalName(number));
  }
  let next = 1;
  for (const id of terminalIds) {
    if (names.has(id)) continue;
    while (taken.has(next)) next++;
    taken.add(next);
    names.set(id, terminalName(next));
  }
  return names;
}

/** As its tab is called: the first plain, the others numbered (panel-tools.ts `tabLabel`). */
const terminalName = (number: number) => (number === 1 ? panelToolLabels.terminal : `${panelToolLabels.terminal} ${number}`);
