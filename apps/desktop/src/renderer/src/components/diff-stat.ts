/**
 * Insertions and deletions in a unified diff. `review.threadDiff` returns the
 * patch but no counts, and the composer strip wants the two numbers without a
 * second round trip to the core.
 */
export function patchStat(patch: string): { insertions: number; deletions: number } {
  let insertions = 0;
  let deletions = 0;
  for (const line of patch.split("\n")) {
    // The file headers start with the same characters as the content lines.
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) insertions += 1;
    else if (line.startsWith("-")) deletions += 1;
  }
  return { insertions, deletions };
}
