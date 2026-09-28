/** A unified diff with `changedLines` changed lines, for the diff viewer benchmark. */
export function makeSyntheticPatch(changedLines: number, hunkSize = 200): string {
  const hunks = Math.ceil(changedLines / hunkSize);
  const lines: string[] = ["diff --git a/src/export.ts b/src/export.ts", "index 1111111..2222222 100644", "--- a/src/export.ts", "+++ b/src/export.ts"];
  let oldLine = 1;
  let newLine = 1;
  for (let h = 0; h < hunks; h += 1) {
    const removed = Math.floor(hunkSize / 2);
    const added = hunkSize - removed;
    const context = 3;
    lines.push(`@@ -${oldLine},${removed + context * 2} +${newLine},${added + context * 2} @@ function exportRows${h}()`);
    for (let c = 0; c < context; c += 1) lines.push(`   const before${h}_${c} = normalise(rows[${c}]);`);
    for (let i = 0; i < removed; i += 1) lines.push(`-  const legacy${h}_${i} = rows.map((r) => r.value * ${i}).join(",");`);
    for (let i = 0; i < added; i += 1) lines.push(`+  const csv${h}_${i} = escapeCsv(rows[${i}]?.title ?? "", { quote: true, newline: "\\n" });`);
    for (let c = 0; c < context; c += 1) lines.push(`   const after${h}_${c} = finalise(before${h}_${c});`);
    oldLine += removed + context * 2 + 40;
    newLine += added + context * 2 + 40;
  }
  return lines.join("\n") + "\n";
}
