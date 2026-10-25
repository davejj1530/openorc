import { router } from "expo-router";
import { perfEnabled, perfScenario, perfThread, report } from "../thread/perf-probe";
import { Settings } from "react-native";

/*
 * The Changes screen's performance runs, driven from the thread a run opens (`-openorcPerfScenario`):
 *   changes-open     the time from the tap to the list's first rows
 *   changes-scroll   the whole list scrolled down a screen at a time, UI frames sampled
 *   diff-scroll      the file named by -openorcPerfPath opened, then scrolled to its end the same way
 *   changes-live     JS work per frame on the Changes screen while the agent streams and the list refreshes
 */
const SCENARIOS = new Set(["changes-open", "changes-scroll", "diff-scroll", "changes-live"]);
export const isChangesScenario = (scenario: string): boolean => SCENARIOS.has(scenario);
export const changesScenario = (): string | null => (perfEnabled() && isChangesScenario(perfScenario()) ? perfScenario() : null);
export const perfPath = (): string | null => (Settings.get("openorcPerfPath") as string | undefined) ?? null;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let opening: number | null = null;

/** A beat after the thread opened, as a person would take: the header button's tap. */
export async function openChanges(cancelled: () => boolean): Promise<void> {
  await wait(2500);
  const threadId = perfThread();
  if (!threadId || cancelled()) return;
  opening = performance.now();
  router.push({ pathname: "/changes", params: { threadId } });
}

/** The Changes screen drew its first rows: from the tap to the frame after. */
export function reportChangesOpened(files: number): void {
  if (opening === null) return;
  const start = opening;
  opening = null;
  requestAnimationFrame(() => report("changes-open", { ms: Math.round(performance.now() - start), files }));
}

/** Scrolls a screen at a time until `step` says the end is reached, sampling the whole way. */
export async function scrollToEnd(sampler: { begin(): void; finish(name: string, extra?: Record<string, unknown>): void }, name: string, step: () => boolean, stepMs = 300): Promise<void> {
  sampler.begin();
  let steps = 0;
  while (steps < 1000 && step()) {
    steps++;
    await wait(stepMs);
  }
  sampler.finish(name, { steps });
}
