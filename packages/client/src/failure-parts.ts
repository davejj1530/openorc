/** A failure's first line, what went wrong, apart from what follows it, such as a daemon's log, shown on demand. */
export function failureParts(text: string): { headline: string; details: string | null } {
  const [first = "", ...rest] = text.trim().split("\n");
  return { headline: first.trim(), details: rest.join("\n").trim() || null };
}
