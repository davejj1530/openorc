/** The production review surface over a three-file patch, for the fold and its header. */
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { DiffView } from "../../apps/desktop/src/renderer/src/components/DiffView";
import { useTheme, type ThemeChoice } from "../../apps/desktop/src/renderer/src/lib/theme";

const patch = [
  `diff --git a/src/renderer/src/lib/layout.ts b/src/renderer/src/lib/layout.ts`,
  `--- a/src/renderer/src/lib/layout.ts`,
  `+++ b/src/renderer/src/lib/layout.ts`,
  `@@ -1,3 +1,4 @@`,
  ` export const open = true;`,
  `-export const tab = "changes";`,
  `+export const tab = "commits";`,
  `+export const folded = false;`,
  ` export const width = 320;`,
  `diff --git a/README.md b/README.md`,
  `new file mode 100644`,
  `--- /dev/null`,
  `+++ b/README.md`,
  `@@ -0,0 +1,2 @@`,
  `+# OpenOrc`,
  `+Local-first.`,
  `diff --git a/old.txt b/old.txt`,
  `deleted file mode 100644`,
  `--- a/old.txt`,
  `+++ /dev/null`,
  `@@ -1,1 +0,0 @@`,
  `-gone`,
  ``,
].join("\n");

/** A one-file patch: the case the fold policy lets open on arrival. */
const single = patch.split(/^(?=diff --git )/m).filter(Boolean)[1] ?? "";

const long = Array.from({ length: 45 }, (_, file) =>
  [
    `diff --git a/file-${file}.ts b/file-${file}.ts`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/file-${file}.ts`,
    "@@ -0,0 +1,100 @@",
    ...Array.from({ length: 100 }, (_, line) => `+export const value${line} = ${line};`),
    "",
  ].join("\n"),
).join("");

function App() {
  const [shown, setShown] = useState(patch);
  Object.assign(window, {
    foldSmoke: {
      theme: (choice: ThemeChoice) => useTheme.getState().set(choice),
      empty: () => setShown(""),
      full: () => setShown(patch),
      single: () => setShown(single),
      long: () => setShown(long),
    },
  });
  // Remounting per patch is what the panels do when a thread changes, and it is what puts
  // the arrival policy back in play rather than reusing the reader's folds.
  return (
    <div style={{ height: "100vh" }}>
      <DiffView key={shown.length} patch={shown} />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
