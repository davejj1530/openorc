import { Tooltip } from "@base-ui/react/tooltip";
import { HOSTED_REASONS } from "@openorc/protocol";
import { floatingGround } from "../lib/use-anchor-ground";
import { commandRows, type SuggestionRow } from "./composer-commands";
import { HostedControlReason } from "./HostedControlReason";

/** Missing context has no numeric value to draw. The existing details control explains its absence. */
export function HostedUnknownContext() {
  return (
    <HostedControlReason label="Context usage" reason={HOSTED_REASONS.usage}>
      <button type="button" className="composer-context" disabled>
        Context
      </button>
    </HostedControlReason>
  );
}

export function hostedCommandReason(value: string): string | null {
  const name = /^\/(compact|fork)(?:\s|$)/.exec(value)?.[1];
  return name === "compact" ? HOSTED_REASONS.compact : name === "fork" ? HOSTED_REASONS.fork : null;
}

export function blockHostedCommandKey(reason: string | null, value: string, event: KeyboardEvent): boolean {
  if (!reason || event.key !== "Enter" || event.shiftKey || event.isComposing || !hostedCommandReason(value)) return false;
  event.preventDefault();
  return true;
}

/** Keep unavailable app commands visible without sending them as agent messages or clearing the draft. */
export function hostedCommandSuggestions(token: { start: number; token: string } | null): SuggestionRow[] {
  if (!token || token.start !== 0 || !token.token.startsWith("/")) return [];
  return (["compact", "fork"] as const)
    .filter((name) => name.startsWith(token.token.slice(1).toLowerCase()))
    .map((name) => ({ key: `action:/${name}`, label: `/${name}`, unavailable: HOSTED_REASONS[name], pick: () => {} }));
}

export function cloudCommandRows(reason: string | null, commands: Parameters<typeof commandRows>[0], draft: Parameters<typeof commandRows>[1], token: { start: number; token: string } | null) {
  if (!reason) return commandRows(commands, draft);
  return [
    ...hostedCommandSuggestions(token),
    ...commandRows(
      commands.filter((command) => command.name !== "compact" && command.name !== "fork"),
      draft,
    ),
  ];
}

export function hostedFileSuggestion(reason: string | null): SuggestionRow[] {
  return reason ? [{ key: "hosted-files", label: "File from the project", group: "Files", unavailable: reason, pick: () => {} }] : [];
}

/** Arrow-key selection keeps focus in the editor; it still opens the selected disabled row's reason. */
export function HostedSuggestion({ row, id, active }: { row: SuggestionRow; id: string; active: boolean }) {
  return (
    <Tooltip.Provider delay={400}>
      <Tooltip.Root open={active || undefined}>
        <Tooltip.Trigger
          render={<button id={id} role="option" aria-disabled="true" aria-selected={active} tabIndex={-1} className="composer-suggestion" onMouseDown={(event) => event.preventDefault()} />}
        >
          <span className="composer-suggestion-label" data-mono>
            {row.label}
          </span>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Positioner sideOffset={6}>
            <Tooltip.Popup ref={floatingGround} className="tooltip-popup">
              {row.unavailable}
            </Tooltip.Popup>
          </Tooltip.Positioner>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}
