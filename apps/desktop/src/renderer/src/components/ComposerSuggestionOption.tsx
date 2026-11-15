import { cn } from "../lib/cn";
import { AccountFace } from "./AccountFace";
import type { SuggestionRow } from "./composer-commands";
import { ConnectorLogo } from "./ConnectorLogo";

/**
 * One row of the composer's suggestions: what picking it puts in the message, after a connector's image or a person's
 * face, and its hint. Pressing picks without taking focus from the message.
 */
export function ComposerSuggestionOption({ row, id, selected, onPoint }: { row: SuggestionRow; id: string; selected: boolean; onPoint: () => void }) {
  return (
    <button
      id={id}
      tabIndex={-1}
      role="option"
      aria-selected={selected}
      aria-disabled={row.unavailable ? true : undefined}
      data-tip={row.unavailable}
      data-agent-mention={row.mention}
      onMouseDown={(e) => {
        e.preventDefault();
        row.pick();
      }}
      // A move, not an enter: a row scrolling under a still pointer must not take the selection from the arrow keys.
      onMouseMove={onPoint}
      className="composer-suggestion"
    >
      {/* The label is the thing being inserted, so the hint gives way first. A
      skill's description runs to a paragraph and would otherwise squeeze the
      name it belongs to down to nothing. Half the row is the ceiling, so a
      long file path still truncates rather than crowding out its own hint. */}
      <span className={cn("composer-suggestion-label", (row.insert || row.logo) && "skill-token")} data-mono={row.mention || row.face ? undefined : true}>
        {row.logo ? <ConnectorLogo title={row.logo.title} logo={row.logo.logo} size={16} /> : null}
        {row.face ? <AccountFace name={row.face.name} image={row.face.image} /> : null}
        {row.label}
      </span>
      {row.hint ? <span className="composer-suggestion-hint">{row.hint}</span> : null}
    </button>
  );
}
