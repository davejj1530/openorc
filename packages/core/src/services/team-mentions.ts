/**
 * Who a chat message addresses, from `@` mentions in its text. Names may have
 * several words, so the longest matching name wins; `@everyone` or `@all`
 * means the whole team and `@lead` means whoever leads it.
 */
export interface MentionableMember {
  key: string;
  name: string;
  managerKey: string | null;
}

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function teamMentions(text: string, members: readonly MentionableMember[]): string[] {
  const found = new Set<string>();
  const names = [...members].sort((a, b) => b.name.length - a.name.length || b.key.length - a.key.length);
  const lead = members.find((member) => member.managerKey === null);
  const remember = (member: MentionableMember | undefined, everyone = false) => {
    if (everyone) found.add("all");
    else if (member) found.add(member.managerKey === null ? "lead" : member.key);
  };
  const alternatives = ["everyone", "all", "lead", ...names.flatMap((member) => [escape(member.name), escape(member.key)])];
  const pattern = new RegExp(`(?:^|[^\\w@])@(${alternatives.join("|")})(?![\\w-])`, "giu");
  for (const match of text.matchAll(pattern)) {
    const token = match[1]!.toLowerCase();
    if (token === "everyone" || token === "all") {
      remember(undefined, true);
      continue;
    }
    if (token === "lead") {
      remember(lead);
      continue;
    }
    remember(names.find((member) => member.name.toLowerCase() === token || member.key.toLowerCase() === token));
  }
  return [...found];
}

/** Explicit recipients take priority; mentions are the fallback, not an extra broadcast. */
export function selectedRecipients(explicit: readonly string[] | undefined, mentioned: string[]): string[] | null {
  if (explicit?.length) return [...new Set(explicit)];
  if (mentioned.length) return mentioned;
  return null;
}
