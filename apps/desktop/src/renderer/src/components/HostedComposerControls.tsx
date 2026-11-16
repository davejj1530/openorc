import { HOSTED_REASONS } from "@openorc/protocol";
import { commandRows, nextPickable, type SuggestionRow } from "./composer-commands";

export function hostedCommandReason(value: string): string | null {
  const name = /^\/(compact|fork)(?:\s|$)/.exec(value)?.[1];
  if (name === "compact") return HOSTED_REASONS.compact;
  return name === "fork" ? HOSTED_REASONS.fork : null;
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

export function nextCommandSuggestion(reason: string | null, rows: SuggestionRow[], current: number, direction: 1 | -1): number {
  return reason && rows.length ? (current + direction + rows.length) % rows.length : nextPickable(rows, current, direction);
}
