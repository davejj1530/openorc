/** Uncommitted edits the stills show on the panel's Changes page. Nothing here is a real project. */

type LineType = "context" | "add" | "del";

export interface DiffFile {
  path: string;
  /** Git's letter for the change; M unless given. */
  letter?: string;
  added: number;
  removed: number;
  /** The file's diff, when it shows open: each row's kind, line number and code. */
  lines?: [LineType, number, string][];
}

/** Codex's welcome screen in studio. */
export const welcomeDiff: DiffFile = {
  path: "src/Welcome.tsx",
  added: 8,
  removed: 2,
  lines: [
    ["context", 1, "import { ProjectPicker } from './ProjectPicker';"],
    ["add", 2, "import { Button } from './ui';"],
    ["context", 3, ""],
    ["context", 4, "export function Welcome() {"],
    ["context", 5, "  return ("],
    ["del", 5, '    <main className="empty">'],
    ["del", 6, "      <p>No projects yet.</p>"],
    ["add", 6, '    <main className="welcome">'],
    ["add", 7, "      <h1>Make yourself at home.</h1>"],
    ["add", 8, "      <p>Connect a project to start building.</p>"],
    ["context", 9, "      <ProjectPicker />"],
    ["add", 10, "      <Button onClick={startConversation}>"],
    ["add", 11, "        Start a conversation"],
    ["add", 12, "      </Button>"],
    ["add", 13, "      <KeyboardHint />"],
    ["context", 14, "    </main>"],
    ["context", 15, "  );"],
    ["context", 16, "}"],
  ],
};

/** Claude's command menu, mid-turn: the ranking it rewrote, and the menu it is still changing. */
export const commandMenuDiff: DiffFile[] = [
  {
    path: "src/command-menu/rank.ts",
    added: 5,
    removed: 1,
    lines: [
      ["context", 1, "import { score } from './score';"],
      ["context", 2, ""],
      ["context", 3, "export function rank(items: Item[], query: string) {"],
      ["del", 4, "  return items.filter((item) => item.title.includes(query));"],
      ["add", 4, "  return items"],
      ["add", 5, "    .map((item) => ({ item, score: score(item.title, query) }))"],
      ["add", 6, "    .filter((entry) => entry.score > 0)"],
      ["add", 7, "    .sort((a, b) => b.score - a.score)"],
      ["add", 8, "    .map((entry) => entry.item);"],
      ["context", 9, "}"],
    ],
  },
  { path: "src/command-menu/CommandMenu.tsx", added: 9, removed: 2 },
];

/** The website's hero, rewritten to say what studio does. */
export const storyDiff: DiffFile = {
  path: "src/pages/index.astro",
  added: 2,
  removed: 2,
  lines: [
    ["context", 1, "---"],
    ["context", 2, "import Layout from '../layouts/Layout.astro';"],
    ["context", 3, "---"],
    ["context", 4, ""],
    ["context", 5, "<Layout>"],
    ["context", 6, '  <section class="hero">'],
    ["del", 7, "    <h1>The all-in-one platform for modern teams</h1>"],
    ["del", 8, "    <p>Powerful features to supercharge your workflow.</p>"],
    ["add", 7, "    <h1>Studio turns a folder into a working app.</h1>"],
    ["add", 8, "    <p>Describe the change and watch it run.</p>"],
    ["context", 9, '    <a href="/download">Download</a>'],
    ["context", 10, "  </section>"],
    ["context", 11, "</Layout>"],
  ],
};
