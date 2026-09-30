import type { PanelTab } from "./layout";

/** Tabs that hold something only when the thread does. */
type ContentTab = "changes" | "plan" | "tasks" | "checkpoints" | "commits" | "memory";
/** Tabs that are tools rather than content: they join the strip once opened for a scope. */
export type PanelTool = "terminal" | "browser" | "instructions";
/** Whether each content tab has something to show. Null leaves content tabs unfiltered. */
export type PanelSignals = Partial<Record<ContentTab, boolean>> | null;

export const panelTools: readonly PanelTool[] = ["terminal", "browser", "instructions"];
const contentTabs: readonly PanelTab[] = ["changes", "plan", "tasks", "checkpoints", "commits", "memory"];

export function isPanelTool(tab: PanelTab): tab is PanelTool {
  return (panelTools as readonly PanelTab[]).includes(tab);
}

/**
 * The strip keeps the context's own order and drops what has nothing to show: a content tab
 * needs its signal, a tool needs to have been opened here. The pinned tab, the one the reader
 * opened in this panel, always stays so nothing is pulled out from under them.
 */
export function visibleTabs(candidates: readonly PanelTab[], signals: PanelSignals, opened: readonly PanelTool[], pinned: PanelTab | null): PanelTab[] {
  return candidates.filter((tab) => {
    if (tab === pinned) return true;
    if (isPanelTool(tab)) return opened.includes(tab);
    return signals === null || !contentTabs.includes(tab) || signals[tab as ContentTab] === true;
  });
}

/** Tools this context offers that are not in the strip yet, for the add menu. */
export function closedTools(candidates: readonly PanelTab[], visible: readonly PanelTab[]): PanelTool[] {
  return panelTools.filter((tool) => candidates.includes(tool) && !visible.includes(tool));
}
