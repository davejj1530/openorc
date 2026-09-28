/** Recognize a provider's unified diff without loading the code renderer. */
export function isUnifiedDiff(text: string): boolean {
  return /^(?:diff --git |--- [^\n]+\n\+\+\+ )/m.test(text);
}

/** Codex fileChange entries may carry a full patch or just numbered hunks. */
export function toolDiff(input: unknown): string | null {
  if (!Array.isArray(input)) return null;
  const patches: string[] = [];
  for (const entry of input) {
    if (!entry || typeof entry !== "object" || typeof entry.path !== "string" || typeof entry.diff !== "string") return null;
    const diff = entry.diff as string;
    if (isUnifiedDiff(diff)) patches.push(diff);
    else if (/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/m.test(diff)) {
      const kind = typeof entry.kind === "string" ? entry.kind : entry.kind?.type;
      const oldPath = kind === "add" ? "/dev/null" : `a/${entry.path}`;
      const newPath = kind === "delete" ? "/dev/null" : `b/${entry.path}`;
      patches.push(
        `diff --git ${JSON.stringify(`a/${entry.path}`)} ${JSON.stringify(`b/${entry.path}`)}\n--- ${oldPath === "/dev/null" ? oldPath : JSON.stringify(oldPath)}\n+++ ${newPath === "/dev/null" ? newPath : JSON.stringify(newPath)}\n${diff}`,
      );
    } else return null; // Do not invent line numbers for unnumbered snippets.
  }
  return patches.length ? patches.map((patch) => (patch.endsWith("\n") ? patch : `${patch}\n`)).join("") : null;
}
