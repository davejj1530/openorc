/**
 * A list as English says it: "Claude", "Claude and Codex", "Claude, Codex, and OpenCode". What `Intl.ListFormat`
 * gives for a conjunction, written out because the phone's JavaScript engine has no `Intl.ListFormat`, and code here
 * runs on the phone too.
 */
export function listWords(items: readonly string[]): string {
  if (items.length <= 2) return items.join(" and ");
  return `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
}
