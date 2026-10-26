import { WORKSPACE_ID, type Project, type Run, type ThreadSummary } from "@openorc/protocol";
import { ran, readFile, searched, thought, turn, type Draft } from "./drafts";

/** A thread of the demo, the run it reads from, and what that run already said. */
export interface StoryThread {
  thread: ThreadSummary;
  run: Run;
  history: Draft[];
  /** Whether the run's session is still open, so the next message continues it. */
  live: boolean;
}

const MINUTE = 60_000;

export function storyProjects(now: number): Project[] {
  const project = (id: string, name: string): Project => ({
    id,
    name,
    rootPath: `/Users/demo/dev/${id}`,
    gitRemote: null,
    defaultBranch: "main",
    settings: { setupScript: null, worktreeInclude: [], branchPrefix: "", detectedConfigs: [] },
    createdAt: now - 90 * 24 * 60 * MINUTE,
    updatedAt: now - 24 * 60 * MINUTE,
  });
  return [project("website", "website"), project("openorc", "openorc")];
}

/** A thread summary as the Mac lists it, quiet unless `facts` say otherwise. */
export function storyThread(now: number, id: string, projectId: string, title: string, minutesAgo: number, facts: Partial<ThreadSummary>): ThreadSummary {
  const at = now - minutesAgo * MINUTE;
  return {
    id,
    projectId,
    title,
    agent: "claude",
    model: "claude-opus-5-5",
    effort: "high",
    fastMode: false,
    mode: "act",
    permissionMode: "trusted",
    workspaceMode: "current",
    branch: null,
    worktreePath: null,
    baseSha: null,
    baseBranch: null,
    pinnedAt: null,
    seenAt: at,
    doneAt: null,
    snoozedUntil: null,
    prUrl: null,
    prState: null,
    forkedFromId: null,
    forkedAtRunId: null,
    draft: null,
    importedFrom: null,
    createdAt: at - 20 * MINUTE,
    updatedAt: at,
    lastActivityAt: at,
    archivedAt: null,
    hasStarted: true,
    activity: "idle",
    unread: false,
    session: { status: "idle", message: null },
    context: null,
    queued: [],
    lastAgentEventAt: null,
    liveRunId: null,
    taskCount: 0,
    openTaskCount: 0,
    ...facts,
  };
}

export function storyRun(thread: ThreadSummary, id: string, live: boolean): Run {
  return {
    id,
    threadId: thread.id,
    taskId: null,
    agent: thread.agent,
    model: thread.model,
    effort: thread.effort,
    fastMode: false,
    mode: thread.mode,
    permissionMode: thread.permissionMode,
    externalSessionId: null,
    state: live ? "running" : "success",
    startedAt: thread.createdAt,
    endedAt: live ? null : thread.lastActivityAt,
    usage: null,
    resultText: null,
    error: null,
  };
}

/** A run's history: its session, its turns, and its end when the session closed. */
export function storyHistory(agent: "claude" | "codex", model: string, turns: Draft[], live: boolean): Draft[] {
  const ended: Draft[] = live ? [] : [{ type: "session.completed", status: "success", durationMs: 1, turns: 1 }];
  return [{ type: "session.started", agent, externalSessionId: null, model, tools: [] }, ...turns, ...ended];
}

const pairingReview = `Two things to change, neither exploitable today.

1. **An offer outlives a failed handshake.** \`acceptLink\` spends the offer only after the Noise handshake completes, so a phone that drops mid-handshake leaves the offer open until it expires. Spend it when the phone's hello arrives instead.
2. **Expiry is checked on the phone only.** The Mac compares \`expiresAt\` when it builds the QR code but never again on accept. A code scanned after five minutes still pairs if the offer is open.

The rest holds up: the secret is compared in constant time and the Mac's key is pinned by the code.`;

const notes = `**OpenOrc 0.9**

- Threads page their history, so a long one opens at once.
- The phone pairs over Wi-Fi or Tailscale and keeps working when you switch.
- Changes shows each file's diff on its own, with Commit and Push.
- Fixed: the sidebar headline no longer flickers while an agent works.`;

const week = `This week in **openorc** and **website**:

- 14 threads, 9 of them merged into main.
- The phone app reached Changes and Preview.
- Two threads still open: transcript paging and the hero spacing.`;

/** The demo's finished threads, each with one turn to read. */
export function storyThreads(now: number): StoryThread[] {
  const pairing = storyThread(now, "demo-pairing", "openorc", "Review the pairing handshake", 40, { unread: true, seenAt: now - 90 * MINUTE });
  const paging = storyThread(now, "demo-paging", "openorc", "Page long transcripts", 130, {
    agent: "codex",
    model: "gpt-5.5",
    workspaceMode: "worktree",
    branch: "perf/transcript-paging",
    worktreePath: "/Users/demo/.openorc/worktrees/paging",
    baseSha: "5d1c2a0e7b3f4c6d8e9a1b2c3d4e5f6a7b8c9d0e",
    baseBranch: "main",
  });
  const notesThread = storyThread(now, "demo-notes", "openorc", "Release notes for 0.9", 26 * 60, { pinnedAt: now - 20 * 60 * MINUTE });
  const weekThread = storyThread(now, "demo-week", WORKSPACE_ID, "Summarize the week", 50 * 60, { model: "claude-sonnet-5-5", effort: "medium" });
  return [
    {
      thread: pairing,
      run: storyRun(pairing, "demo-run-pairing", false),
      live: false,
      history: storyHistory(
        "claude",
        "claude-opus-5-5",
        turn(
          "turn-1",
          "Review packages/link/src/connect.ts for anything that would let a stale offer pair.",
          [
            ...thought("pairing-think", "The offer is spent in acceptLink; check when, and where expiry is compared."),
            ...readFile("pairing-read-1", "packages/link/src/connect.ts", "export async function acceptLink(options: AcceptOptions) {\n  const hello = await readHello(socket);\n  …"),
            ...readFile("pairing-read-2", "packages/link/src/pairing.ts", "export function decodePairingUrl(url: string): PairingOffer {\n  …"),
            ...searched("pairing-grep", "expiresAt", "packages", "packages/link/src/pairing.ts:41\npackages/core/src/remote/pairing.ts:28\napps/mobile/src/connection/manager.ts:212"),
          ],
          pairingReview,
          94_000,
        ),
        false,
      ),
    },
    {
      thread: paging,
      run: storyRun(paging, "demo-run-paging", false),
      live: false,
      history: storyHistory(
        "codex",
        "gpt-5.5",
        turn(
          "turn-1",
          "Opening a long thread loads every turn at once. Page it from the newest turn back.",
          [
            ...ran("paging-rg", "commandExecution", 'rg -n "events.page" packages', "packages/core/src/handlers/events.ts:18\npackages/client/src/run-store.ts:139"),
            ...readFile("paging-read", "packages/core/src/handlers/events.ts", "export const eventsPage = …"),
            ...ran("paging-test", "commandExecution", "pnpm --filter @openorc/client test", "Test Files  41 passed (41)\n     Tests  612 passed (612)"),
          ],
          "Threads now open on their newest three turns and load older ones a page at a time as you scroll up. `events.page` takes `fromTurn`, and the run store keeps what it already drew, so scrolling back never redraws the turns on screen.",
          212_000,
        ),
        false,
      ),
    },
    {
      thread: notesThread,
      run: storyRun(notesThread, "demo-run-notes", false),
      live: false,
      history: storyHistory(
        "claude",
        "claude-opus-5-5",
        turn(
          "turn-1",
          "Draft release notes from the commits since 0.8.",
          ran("notes-log", "Bash", "git log --oneline v0.8.0..HEAD", "a41c2e9 feat(mobile): Changes and Commit\n7d03b1f perf(client): page transcripts\n…"),
          notes,
          41_000,
        ),
        false,
      ),
    },
    {
      thread: weekThread,
      run: storyRun(weekThread, "demo-run-week", false),
      live: false,
      history: storyHistory("claude", "claude-sonnet-5-5", turn("turn-1", "What happened across my projects this week?", [], week, 18_000), false),
    },
  ];
}
