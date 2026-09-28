/** A run of the message, marked when it invokes a skill the provider will resolve. */
export interface SkillSegment {
  text: string;
  skill: boolean;
}

/**
 * The parts of a message that name a skill.
 *
 * Only a name the project actually has counts, so a stray slash, a path, or a
 * command the app owns stays plain. A skill token also has to start a word,
 * because `http://x/formatting` contains one of these names and means nothing
 * by it. Plugin skills carry a colon, which is why the set is matched against
 * rather than a character class.
 *
 * Returns segments rather than HTML so the caller decides how to paint them,
 * and so this can be tested without a document.
 */
export function skillSegments(text: string, names: ReadonlySet<string>, prefix: "/" | "$" = "/"): SkillSegment[] {
  if (names.size === 0 || text === "") return text === "" ? [] : [{ text, skill: false }];
  // Longest first, so `/figma:figma-use` is not cut short by a `/figma` that
  // also exists. Escaped because a skill name is a directory name, not a pattern.
  const alternatives = [...names].sort((a, b) => b.length - a.length).map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const marker = prefix === "$" ? "\\$" : "/";
  const pattern = new RegExp(`(^|\\s)(${marker}(?:${alternatives.join("|")}))(?![\\w:-])`, "g");
  const segments: SkillSegment[] = [];
  let at = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index + (match[1] ?? "").length;
    if (start > at) segments.push({ text: text.slice(at, start), skill: false });
    segments.push({ text: match[2] ?? "", skill: true });
    at = start + (match[2] ?? "").length;
  }
  if (at < text.length) segments.push({ text: text.slice(at), skill: false });
  return segments;
}
