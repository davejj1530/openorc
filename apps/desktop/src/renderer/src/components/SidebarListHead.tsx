import type { ReactNode } from "react";
import { useUi } from "../lib/ui";
import { Search } from "./icons";
import { OpenOrcMark } from "./OpenOrcMark";

/** OpenOrc's wordmark: the cube and the name, always in Immaculate Gothic. Short of room, the name gives way whole. */
export function Wordmark() {
  return (
    <div className="sidebar-wordmark" role="img" aria-label="OpenOrc">
      <OpenOrcMark size={16} className="shrink-0" />
      <span className="sidebar-wordmark-name">OpenOrc</span>
    </div>
  );
}

/**
 * The head of the sidebar's list: Search, the app's one search, which opens the palette over the window, then at the
 * row's end the list's own tools (filter, Add project and New thread, or New Orcling).
 */
export function SidebarListHead({ tools }: { tools: ReactNode }) {
  return (
    <div className="sidebar-list-head">
      <button type="button" className="sidebar-search no-drag" onClick={() => useUi.getState().setPalette(true)}>
        <Search size={16} />
        Search
      </button>
      <div className="sidebar-list-tools">{tools}</div>
    </div>
  );
}
