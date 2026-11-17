import { commandRows, nextPickable, type SuggestionRow } from "./composer-commands";
import { useHostedControlReason } from "./HostedConversationBoundary";

/** Why each of the app's own commands is held in this conversation: null where it runs, as on this Mac. */
export type HeldCommands = { compact: string | null; fork: string | null };
const NAMES = ["compact", "fork"] as const;

export function useHeldCommands(): HeldCommands {
  return { compact: useHostedControlReason("compact"), fork: useHostedControlReason("fork") };
}

const anyHeld = (held: HeldCommands) => NAMES.some((name) => held[name] !== null);

export function hostedCommandReason(held: HeldCommands, value: string): string | null {
  const name = /^\/(compact|fork)(?:\s|$)/.exec(value)?.[1] as (typeof NAMES)[number] | undefined;
  return name ? held[name] : null;
}

export function blockHostedCommandKey(held: HeldCommands, value: string, event: KeyboardEvent): boolean {
  if (event.key !== "Enter" || event.shiftKey || event.isComposing || !hostedCommandReason(held, value)) return false;
  event.preventDefault();
  return true;
}

/** Keep held app commands visible without sending them as agent messages or clearing the draft. */
export function hostedCommandSuggestions(held: HeldCommands, token: { start: number; token: string } | null): SuggestionRow[] {
  if (!token || token.start !== 0 || !token.token.startsWith("/")) return [];
  return NAMES.filter((name) => held[name] !== null && name.startsWith(token.token.slice(1).toLowerCase())).map((name) => ({
    key: `action:/${name}`,
    label: `/${name}`,
    unavailable: held[name]!,
    pick: () => {},
  }));
}

export function cloudCommandRows(held: HeldCommands, commands: Parameters<typeof commandRows>[0], draft: Parameters<typeof commandRows>[1], token: { start: number; token: string } | null) {
  if (!anyHeld(held)) return commandRows(commands, draft);
  return [
    ...hostedCommandSuggestions(held, token),
    ...commandRows(
      commands.filter((command) => !NAMES.some((name) => command.name === name && held[name] !== null)),
      draft,
    ),
  ];
}

export function hostedFileSuggestion(reason: string | null): SuggestionRow[] {
  return reason ? [{ key: "hosted-files", label: "File from the project", group: "Files", unavailable: reason, pick: () => {} }] : [];
}

/** With a held row in the list, the cursor stops on it too, so its reason shows; otherwise held rows are passed over. */
export function nextCommandSuggestion(holds: boolean, rows: SuggestionRow[], current: number, direction: 1 | -1): number {
  return holds && rows.length ? (current + direction + rows.length) % rows.length : nextPickable(rows, current, direction);
}

export function holdsRows(held: HeldCommands, fileReason: string | null): boolean {
  return fileReason !== null || anyHeld(held);
}
