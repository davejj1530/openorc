import type { Draft } from "./drafts";
import { edited, readFile, searched, thought, turn } from "./drafts";
import type { Beat, Turn } from "./player";
import { storyHistory, storyRun, storyThread, type StoryThread } from "./story";
import type { DemoFile } from "./workspace";

export const HERO_THREAD = "demo-hero";
export const HERO_APPROVAL = "demo-hero-build";
export const HERO_BRANCH = "site/calmer-hero";
export const HERO_PAGE = { address: "localhost:4321", title: "OpenOrc" } as const;

const HOME_CSS = "src/styles/home.css";
const LOGOS = "src/components/AgentLogos.astro";

/** The hero's spacing, as git would print the edit to the site's real stylesheet. */
export const heroSpacing: DemoFile = {
  path: HOME_CSS,
  patch: `@@ -46,9 +46,13 @@ .home-page .hero-title .quiet {
 .home-page .hero-copy .hero-actions {
   flex-direction: column;
   align-items: flex-start;
-  gap: 24px;
-  margin-top: 24px;
+  gap: 16px;
+  margin-top: 32px;
 }
+/* The agents read as the button's caption, so they sit closer to it than it sits to the headline. */
+.home-page .hero-copy .works-with {
+  margin-top: -4px;
+}
 .home-page .hero-copy .button-primary {
   min-height: 44px;
   padding: 0 20px;`,
};

export const logosSize: DemoFile = {
  path: LOGOS,
  patch: `@@ -31,7 +31,7 @@
 <style>
   .works-with {
     color: var(--faint);
-    font-size: 0.8125rem;
+    font-size: 0.75rem;
     line-height: 1.4;
   }
   .works-with-agent {`,
};

const firstAnswer = `Two things crowd it at laptop width:

- **The button sits close to the headline.** \`.hero-actions\` starts 24 px under a 52 px headline, so Download for Mac reads as part of the title.
- **The agents compete with the button.** "Works with Codex, Claude Code and OpenCode" sits 24 px under it at nearly the same size.

I'd give the headline 32 px of room, pull the agents up under the button as its caption, and set them a step smaller.`;

/** The live thread, with the turn it already finished. */
export function heroThread(now: number): StoryThread {
  const thread = storyThread(now, HERO_THREAD, "website", "Calmer hero", 6, {
    permissionMode: "review",
    workspaceMode: "worktree",
    branch: HERO_BRANCH,
    worktreePath: "/Users/demo/.openorc/worktrees/calmer-hero",
    baseSha: "9f2b4c1d0e8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c",
    baseBranch: "main",
    session: { status: "live", message: null },
    liveRunId: "demo-run-hero",
  });
  const history = turn(
    "turn-1",
    "The hero feels crowded on a small laptop. What would you change?",
    [
      ...readFile(
        "hero-read-1",
        "src/pages/index.astro",
        '<div class="hero-copy">\n  <h1 id="hero-title" class="hero-title">…</h1>\n  <div class="hero-actions">\n    <DownloadButton />\n    <AgentLogos />',
      ),
      ...readFile("hero-read-2", HOME_CSS, ".home-page .hero-copy .hero-actions {\n  flex-direction: column;\n  gap: 24px;\n  margin-top: 24px;\n}"),
    ],
    firstAnswer,
    38_000,
  );
  return { thread, run: storyRun(thread, "demo-run-hero", true), history: storyHistory("claude", "claude-opus-5-5", history, true), live: true };
}

/** What the hero's turn does to the demo Mac as it goes: files it edits, the page it opens. */
export interface HeroWorld {
  change(file: DemoFile): void;
  openPage(): void;
}

const step = (after: number, events: Draft[]): Beat => ({ kind: "events", after, events });
/** A call that takes a moment: started, then finished with whatever it changed. */
const tool = (after: number, [started, ...finished]: Draft[]): Beat[] => [step(after, [started!]), step(700, finished)];

const build = [
  "> website@0.9.0 build /Users/demo/.openorc/worktrees/calmer-hero",
  "> astro build",
  "",
  "building client (vite)",
  "✓ 214 modules transformed.",
  "✓ built in 3.12s",
  "▶ src/pages/index.astro",
  "  └─ /index.html (+41ms)",
  "✓ 9 page(s) built in 4.86s",
  "Complete!",
];

/** The turn the demo opens on: the agent edits the hero, shows it, says so, and asks to build. */
export function heroTurn(world: HeroWorld): Turn {
  const [spacing, logos] = [heroSpacing, logosSize];
  return {
    ask: "Do it, and check it builds.",
    beats: [
      ...thought("hero-think", "The gap lives on .hero-copy .hero-actions; the agents line is its last child, so one margin moves it.").map((event, index) => step(index ? 1400 : 1200, [event])),
      ...tool(600, readFile("hero-read-3", HOME_CSS, ".home-page .hero-copy .hero-actions {\n  gap: 24px;\n  margin-top: 24px;\n}")),
      ...tool(500, searched("hero-grep", "works-with", "src", "src/components/AgentLogos.astro:18\nsrc/components/AgentLogos.astro:32")),
      ...tool(700, edited("hero-edit-1", HOME_CSS, "  gap: 24px;\n  margin-top: 24px;", "  gap: 16px;\n  margin-top: 32px;", spacing.patch)),
      { kind: "do", after: 0, run: () => world.change(spacing) },
      ...tool(600, edited("hero-edit-2", LOGOS, "    font-size: 0.8125rem;", "    font-size: 0.75rem;", logos.patch)),
      { kind: "do", after: 0, run: () => world.change(logos) },
      ...tool(600, [
        { type: "tool.started", toolCallId: "hero-page", name: "mcp__openorc__browser", input: { action: "open", url: "http://localhost:4321/" }, parentToolCallId: null },
        { type: "tool.completed", toolCallId: "hero-page", name: "mcp__openorc__browser", output: "Opened http://localhost:4321/", isError: false },
      ]),
      { kind: "do", after: 0, run: () => world.openPage() },
      {
        kind: "say",
        after: 800,
        messageId: "hero-say-1",
        text: "The headline has 32 px of room now, and the agents sit right under Download for Mac, a step smaller, so the button is the first thing you see. I opened the page in Preview. Next I'll build the site to make sure nothing else used those rules.",
      },
      {
        kind: "ask",
        after: 900,
        approvalId: HERO_APPROVAL,
        request: { type: "approval.requested", approvalId: HERO_APPROVAL, kind: "command", toolName: "Bash", input: { command: "pnpm build", description: "Build the website" } },
        allowed: [
          { kind: "output", after: 300, toolCallId: "hero-build", name: "Bash", input: { command: "pnpm build", description: "Build the website" }, lines: build },
          { kind: "say", after: 700, messageId: "hero-say-2", text: "It builds: nine pages, no warnings. Both files are ready to commit on `site/calmer-hero`." },
        ],
        denied: [{ kind: "say", after: 500, messageId: "hero-say-2", text: "Skipped the build. The edits are in place, and Preview shows them." }],
      },
    ],
  };
}

/** A finished website thread whose work is committed and pushed. */
export function logosThread(now: number): StoryThread {
  const thread = storyThread(now, "demo-logos", "website", "Keep the agents on one line", 190, {
    model: "claude-sonnet-5-5",
    effort: "medium",
    workspaceMode: "worktree",
    branch: "fix/works-with-wrap",
    worktreePath: "/Users/demo/.openorc/worktrees/works-with",
    baseSha: "9f2b4c1d0e8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c",
    baseBranch: "main",
  });
  const history = turn(
    "turn-1",
    "On a phone the agents wrap under the button one name at a time. Keep each name with its mark.",
    [
      ...readFile("logos-read", LOGOS, '<span class="works-with-agent">\n  <svg viewBox={agent.viewBox} … />\n  {agent.name}\n</span>'),
      ...edited("logos-edit", LOGOS, "  .works-with-agent {", "  .works-with-agent {\n    white-space: nowrap;", ""),
    ],
    "Each name now stays on one line with its mark, so a narrow screen wraps between agents, never inside one. Committed and pushed to `fix/works-with-wrap`.",
    52_000,
  );
  return { thread, run: storyRun(thread, "demo-run-logos", false), history: storyHistory("claude", "claude-sonnet-5-5", history, false), live: false };
}

export const logosWrap: DemoFile = {
  path: LOGOS,
  patch: `@@ -36,6 +36,7 @@
     line-height: 1.4;
   }
   .works-with-agent {
+    white-space: nowrap;
   }
   .works-with svg {
     width: 14px;`,
};
