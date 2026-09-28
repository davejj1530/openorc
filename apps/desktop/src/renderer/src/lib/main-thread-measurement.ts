/**
 * Observe browser-reported tasks of at least 50 ms. A late timer wakeup is not
 * evidence of a busy renderer, so elapsed time between callbacks is not gated.
 * Only benchmark phases start this observer; finishing disconnects it.
 */
export function beginMainThreadMeasurement() {
  if (!PerformanceObserver.supportedEntryTypes.includes("longtask")) throw new Error("Benchmark requires Chromium longtask measurements");
  const startedAt = performance.now();
  const entries: PerformanceEntry[] = [];
  const observer = new PerformanceObserver((list) => entries.push(...list.getEntries()));
  observer.observe({ type: "longtask" });
  return async () => {
    const endedAt = performance.now();
    // The task that calls finish may itself be long. Chromium only queues its
    // entry after it returns, so takeRecords() alone would miss a final freeze.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    entries.push(...observer.takeRecords());
    observer.disconnect();
    // Include tasks overlapping either boundary, but exclude work done while
    // waiting to drain the observer. Count each overlapping task in full.
    const tasks = entries.filter((entry) => entry.startTime < endedAt && entry.startTime + entry.duration > startedAt);
    return {
      durationMs: endedAt - startedAt,
      longTasksTotal: tasks.length,
      longestTaskMs: Math.round(tasks.reduce((max, entry) => Math.max(max, entry.duration), 0)),
      totalBlockingTimeMs: Math.round(tasks.reduce((total, entry) => total + Math.max(0, entry.duration - 50), 0)),
    };
  };
}
