import { defaultHarnessId, isHarnessId, type HarnessId, type RpcParams } from "@openorc/protocol";
import { core } from "./rpc";
import { openThread, routeFromSpec, useRouter } from "./router";
import { beginBenchmarkFrames, finishBenchmarkFrames, receivedTotals, startStats, useStats } from "./stats";
import { useTheme } from "./theme";
import { useTranscripts, type Block } from "./transcript";
import { useUi } from "./ui";

/**
 * Headless modes for CI and smoke tests, driven by environment variables. They
 * exist only in development and QA builds (OPENORC_QA_BUILD=1); a release
 * build leaves them out, and its preload reads none of these variables.
 *
 *   OPENORC_AUTOBENCH=1                     bridge bench on the diagnostics screen, report, quit
 *   OPENORC_AUTOBENCH_THREAD=1              open a seeded large thread, stream into it and elsewhere, report, quit
 *   OPENORC_AUTORUN_CODEX=1 + _CWD=<repo>   import repo, create a task, run Codex in its worktree,
 *                                            auto-approve, read the diff back, report, quit
 *   OPENORC_AUTORUN_THREAD=1 + _CWD=<repo>  import repo, start a thread, let the agent delegate a task,
 *                                            wait for the task to finish and report back, report, quit
 *   OPENORC_AUTOQUIT=1                      quit after the final report (handled by main)
 */
/** Smokes run on the cheapest capable model unless told otherwise; frontier models cost real money per proof. */
const smokeModels: Record<HarnessId, string> = { codex: "gpt-5.6-sol", claude: "claude-haiku-4-5-20251001", opencode: "opencode/big-pickle" };
function smokeModel(agent: HarnessId): string {
  return window.openorc.autorun.model ?? smokeModels[agent];
}

function smokeBlockLabel(block: Block): string {
  if (block.kind === "message") return `${block.role}: ${block.text.slice(0, 80)}`;
  if (block.kind === "tool") return `tool ${block.name}`;
  return block.kind;
}

/** Opens the window on its launch route and theme, then starts a test run when a QA build was asked for one. */
export function installAutorun(): void {
  const { autorun } = window.openorc;
  if (autorun.theme) useTheme.getState().set(autorun.theme);
  if (autorun.route) openRoute(autorun.route);
  if (__OPENORC_QA__) installTestRun();
}

function installTestRun(): void {
  const { autorun } = window.openorc;
  const agent = isHarnessId(autorun.agent) ? autorun.agent : defaultHarnessId;
  if (autorun.bench) installBench();
  else if (autorun.threadBench) installThreadBench();
  else if (autorun.thread && autorun.cwd) installThreadSmoke(autorun.cwd, autorun.prompt, agent);
  else if (autorun.codex && autorun.cwd) installSmoke(autorun.cwd, autorun.prompt, agent);
}

function openRoute(spec: string): void {
  const [view] = spec.split(":");
  if (view === "newtask") setTimeout(() => useUi.getState().openNewTask(), 800);
  else if (view === "palette") setTimeout(() => useUi.getState().setPalette(true), 800);
  else {
    const route = routeFromSpec(spec);
    if (route) useRouter.getState().navigate(route);
  }
}

async function snapshot(): Promise<Record<string, unknown>> {
  const received = receivedTotals();
  const metrics = await window.openorc.metrics();
  const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
  return {
    coldStartMs: metrics.coldStartMs,
    workingSetTotalMb: Math.round(metrics.processes.reduce((a, p) => a + p.workingSetKb, 0) / 1024),
    jsHeapMb: mem ? Math.round(mem.usedJSHeapSize / 1048576) : null,
    eventsReceived: received.eventsReceived,
    framesReceived: received.framesReceived,
  };
}

/**
 * Two phases: five fast agents (throughput), then fifty agents at once
 * (memory at scale). CI enforces budgets on both reports.
 */
function installBench(): void {
  startStats();
  const BENCH = { runs: 5, eventsPerSecond: 5000, durationMs: 10_000 };
  const SCALE = { runs: 50, eventsPerSecond: 2000, durationMs: 8_000 };
  let phase: "bench" | "scale" = "bench";
  useRouter.getState().navigate({ view: "diagnostics" });
  core.onReady(() => {
    setTimeout(async () => {
      window.openorc.report({ kind: "idle", ...(await snapshot()) });
      beginBenchmarkFrames();
      await core.call("bench.start", BENCH);
    }, 3000);
  });
  core.onBenchDone((result) => {
    // Include the final delivered frame/render, then end measurement before
    // the reporting delay. Sampling whole seconds also counted idle display pacing.
    requestAnimationFrame(() => {
      const measurement = finishBenchmarkFrames();
      setTimeout(async () => {
        const current = phase === "bench" ? BENCH : SCALE;
        const samples = useStats.getState().samples.slice(-Math.ceil(current.durationMs / 1000) - 1);
        window.openorc.report({
          kind: phase,
          final: phase === "scale",
          bench: current,
          sent: result,
          samples,
          longFramesTotal: measurement.longFramesTotal,
          measurementDurationMs: measurement.durationMs,
          ...(await snapshot()),
        });
        if (phase === "bench") {
          phase = "scale";
          beginBenchmarkFrames();
          await core.call("bench.start", SCALE);
        }
      }, 1200);
    });
  });
}

/**
 * The renderer with a large conversation open: how long the thread takes to show, then frame costs while its own
 * run streams, and while unrelated runs stream, which should cost it nothing.
 */
function installThreadBench(): void {
  startStats();
  const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  // Per-process CPU since the previous call, so each phase's figures cover just that phase.
  const cpu = async () => Object.fromEntries((await window.openorc.metrics()).processes.map((p) => [`${p.type}${p.name ? `:${p.name}` : ""}:${p.pid}`, Math.round(p.cpuPercent)]));
  const measure = async (params: RpcParams<"bench.start"> | null, idleMs = 0) => {
    const perSecond: number[] = [];
    let last = performance.now();
    let second = last;
    let long = 0;
    let sampling = true;
    const tick = (now: number) => {
      if (now - last > 20) long++;
      last = now;
      if (now - second >= 1000) {
        perSecond.push(long);
        long = 0;
        second = now;
      }
      if (sampling) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    await cpu();
    const done = new Promise<{ eventsSent: number } | null>((resolve) => {
      if (!params) return resolve(null);
      const off = core.onBenchDone((result) => {
        off();
        resolve(result);
      });
    });
    beginBenchmarkFrames();
    if (params) await core.call("bench.start", params);
    else await settle(idleMs);
    const sent = await done;
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const frames = finishBenchmarkFrames();
    sampling = false;
    perSecond.push(long);
    return { ...frames, perSecond, eventsSent: sent?.eventsSent ?? 0, cpu: await cpu() };
  };
  core.onReady(() => {
    void (async () => {
      try {
        const { threadId, runIds } = await core.call("bench.seedThread", {});
        await settle(1000);
        const opened = performance.now();
        openThread(threadId);
        while (!document.querySelector(".work-turn")) await new Promise((resolve) => requestAnimationFrame(resolve));
        const openMs = Math.round(performance.now() - opened);
        // Let the first screenful finish loading before streaming.
        await settle(2000);
        const turnsShown = document.querySelectorAll(".work-turn").length;
        const stream = await measure({ runs: 1, eventsPerSecond: 400, durationMs: 8000, runIds: [runIds.at(-1)!] });
        const unrelated = await measure({ runs: 5, eventsPerSecond: 5000, durationMs: 8000 });
        // Diagnostics for the CI runner: the agent orb with no traffic, then the same unrelated traffic without it.
        const orb = document.querySelector<HTMLElement>(".agent-orb");
        const orbShader = Boolean(orb?.querySelector("canvas"));
        const idleWithOrb = await measure(null, 4000);
        if (orb) orb.style.display = "none";
        await settle(300);
        const unrelatedWithoutOrb = await measure({ runs: 5, eventsPerSecond: 5000, durationMs: 8000 });
        if (orb) orb.style.display = "";
        window.openorc.report({ kind: "thread-bench", final: true, openMs, turnsShown, stream, unrelated, diagnostics: { orbShader, idleWithOrb, unrelatedWithoutOrb }, ...(await snapshot()) });
      } catch (error) {
        window.openorc.report({ kind: "thread-bench", final: true, ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    })();
  });
}

function installSmoke(repo: string, prompt: string | null, agent: HarnessId): void {
  startStats();
  const fail = (step: string, e: unknown) => window.openorc.report({ kind: "smoke", final: true, ok: false, step, error: e instanceof Error ? e.message : String(e) });
  core.onReady(() => {
    void (async () => {
      let step = "import";
      try {
        const project = await core.call("projects.import", { rootPath: repo });
        step = "create";
        const task = await core.call("tasks.create", { projectId: project.id, title: `Smoke ${new Date().toISOString().slice(11, 19)}`, useWorktree: true });
        useRouter.getState().navigate({ view: "task", taskId: task.id, tab: "chat" });
        step = "run";
        const run = await core.call("runs.start", {
          taskId: task.id,
          agent,
          model: smokeModel(agent),
          effort: "low",
          mode: "act",
          // The Claude smoke exercises the approval path through the MCP permission tool; Codex approvals arrive from the app-server regardless.
          permissionMode: agent === "claude" ? "review" : "trusted",
          prompt: prompt ?? "Create a file named hello.txt containing the single word hello, then reply with exactly DONE.",
        });
        step = "wait";
        const resolved = new Set<string>();
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("run did not finish a turn in 240 s")), 240_000);
          let closed = false;
          const unsubscribe = useTranscripts.subscribe((state) => {
            const t = state.runs.get(run.id);
            if (!t) return;
            for (const b of t.blocks) {
              if (b.kind === "approval" && !b.decision && !resolved.has(`${run.id}:${b.approvalId}`)) {
                resolved.add(`${run.id}:${b.approvalId}`);
                // Questions get their first option (or "yes"); everything else is allowed.
                const answers: Record<string, string[]> = {};
                if (b.approvalKind === "user_input") {
                  const qs = ((b.input as Record<string, unknown>)?.["questions"] ?? []) as Record<string, unknown>[];
                  for (const q of qs) {
                    const key = typeof q["id"] === "string" ? q["id"] : String(q["question"] ?? "");
                    const first = Array.isArray(q["options"]) ? (q["options"] as Record<string, unknown>[])[0]?.["label"] : undefined;
                    answers[key] = [typeof first === "string" ? first : "yes"];
                  }
                }
                void core.call("approvals.resolve", { runId: run.id, approvalId: b.approvalId, decision: "allow", ...(b.approvalKind === "user_input" ? { answers } : {}) });
              }
            }
            // Codex threads stay open for follow-ups; Claude print mode exits on its own.
            if (t.turnsCompleted >= 1 && !closed && agent === "codex") {
              closed = true;
              void core.call("runs.close", { runId: run.id });
            }
            if ((closed || agent === "claude") && t.turnsCompleted >= 1 && !t.live) {
              clearTimeout(timer);
              unsubscribe();
              resolve();
            }
          });
        });
        step = "diff";
        await new Promise((r) => setTimeout(r, 500));
        const diff = await core.call("review.diff", { taskId: task.id });
        const fresh = await core.call("tasks.get", { id: task.id });
        const runsAfter = await core.call("runs.listForTask", { taskId: task.id });
        const transcript = useTranscripts.getState().runs.get(run.id);
        window.openorc.report({
          kind: "smoke",
          final: true,
          ok: true,
          project: { id: project.id, name: project.name, defaultBranch: project.defaultBranch },
          task: { id: task.id, status: fresh?.status, branch: fresh?.branch, worktreePath: fresh?.worktreePath, baseSha: fresh?.baseSha },
          run: { id: run.id, state: runsAfter.find((r) => r.id === run.id)?.state, model: runsAfter.find((r) => r.id === run.id)?.model },
          approvals: resolved.size,
          blocks: transcript?.blocks.map(smokeBlockLabel),
          diffFiles: diff.files,
          patchHead: diff.patch.slice(0, 300),
          ...(await snapshot()),
        });
      } catch (e) {
        fail(step, e);
      }
    })();
  });
}

/** Auto-answers approvals and questions on any run the transcript store sees, so smokes never stall. */
function autoApprove(): () => void {
  const resolved = new Set<string>();
  return useTranscripts.subscribe((state) => {
    for (const t of state.runs.values()) {
      for (const b of t.blocks) {
        if (b.kind !== "approval" || b.decision) continue;
        const key = `${t.runId}:${b.approvalId}`;
        if (resolved.has(key)) continue;
        resolved.add(key);
        const answers: Record<string, string[]> = {};
        if (b.approvalKind === "user_input") {
          const qs = ((b.input as Record<string, unknown>)?.["questions"] ?? []) as Record<string, unknown>[];
          for (const q of qs) {
            const key = typeof q["id"] === "string" ? q["id"] : String(q["question"] ?? "");
            const first = Array.isArray(q["options"]) ? (q["options"] as Record<string, unknown>[])[0]?.["label"] : undefined;
            answers[key] = [typeof first === "string" ? first : "yes"];
          }
        }
        void core.call("approvals.resolve", { runId: t.runId, approvalId: b.approvalId, decision: "allow", ...(b.approvalKind === "user_input" ? { answers } : {}) });
      }
    }
  });
}

/**
 * The thread-first flow end to end: the agent in the thread delegates a task,
 * the task runs in its worktree, and its result lands back in the thread.
 */
function installThreadSmoke(repo: string, prompt: string | null, agent: HarnessId): void {
  startStats();
  const fail = (step: string, e: unknown) => window.openorc.report({ kind: "thread-smoke", final: true, ok: false, step, error: e instanceof Error ? e.message : String(e) });
  core.onReady(() => {
    void (async () => {
      let step = "import";
      const stopApproving = autoApprove();
      try {
        const project = await core.call("projects.import", { rootPath: repo });
        step = "start";
        const image = window.openorc.autorun.image;
        const { thread } = await core.call("threads.start", {
          projectId: project.id,
          agent,
          model: smokeModel(agent),
          effort: "low",
          mode: "act",
          permissionMode: "trusted",
          prompt:
            prompt ??
            `${image ? "First, say in five words what the attached image shows. Then d" : "D"}elegate exactly one task titled 'Add a greeting file' whose spec is: create hello.txt containing the word hello, then reply DONE. Do not do the work yourself. After you get the task result, reply with exactly THREAD DONE.`,
          ...(image ? { attachments: [image] } : {}),
        });
        useRouter.getState().navigate({ view: "thread", threadId: thread.id });
        step = "delegate";
        const deadline = Date.now() + 420_000;
        const poll = async <T>(what: string, fn: () => Promise<T | null>): Promise<T> => {
          while (Date.now() < deadline) {
            const v = await fn();
            if (v) return v;
            await new Promise((r) => setTimeout(r, 1500));
          }
          throw new Error(`timed out waiting for ${what}`);
        };
        const task = await poll("a task in the thread", async () => (await core.call("tasks.list", { threadId: thread.id }))[0] ?? null);
        step = "task-finish";
        await poll("the task to finish", async () => {
          const t = await core.call("tasks.get", { id: task.id });
          return t && t.status !== "in_progress" && t.status !== "backlog" ? t : null;
        });
        step = "report-back";
        const reportRun = await poll("the task result to reach the thread", async () => {
          const runs = await core.call("runs.listForThread", { threadId: thread.id });
          for (const r of runs) {
            const events = await core.call("events.listForRun", { runId: r.id });
            if (events.some((e) => e.type === "message.completed" && e.role === "system" && /finished/.test(e.text))) return r;
          }
          return null;
        });
        step = "thread-idle";
        await poll("the thread to go idle", async () => {
          const t = await core.call("threads.get", { id: thread.id });
          return t && t.activity === "idle" ? t : null;
        });
        const diff = await core.call("review.diff", { taskId: task.id });
        const finalThread = await core.call("threads.get", { id: thread.id });
        const lastThreadRun = (await core.call("runs.listForThread", { threadId: thread.id })).at(-1);
        window.openorc.report({
          kind: "thread-smoke",
          final: true,
          ok: true,
          thread: {
            id: thread.id,
            title: thread.title,
            taskCount: finalThread?.taskCount,
            activity: finalThread?.activity,
            runs: (await core.call("runs.listForThread", { threadId: thread.id })).length,
          },
          task: { id: task.id, title: task.title, origin: task.origin, status: (await core.call("tasks.get", { id: task.id }))?.status, branch: task.branch },
          reportRunId: reportRun.id,
          lastThreadReply: lastThreadRun?.resultText?.slice(0, 200) ?? null,
          diffFiles: diff.files.map((f) => f.path),
          ...(await snapshot()),
        });
      } catch (e) {
        fail(step, e);
      } finally {
        stopApproving();
      }
    })();
  });
}
