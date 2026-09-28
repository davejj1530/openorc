# Desktop benchmarks

The CI Bridge benchmark job builds the desktop app with `OPENORC_QA_BUILD=1`, then runs the bridge/scale and large-thread autoruns. Release builds omit these autoruns.

The two benchmark modes disable [background throttling](https://www.electronjs.org/docs/latest/api/structures/web-preferences) so covering the QA window does not pause its timers or animation frames mid-workload. Other launches retain Electron's default background throttling.

Each phase records two timing signals:

- **Animation frames:** `longFramesTotal` counts `requestAnimationFrame` gaps over 20 ms, and `longestFrameMs` records the longest gap. These are diagnostics for display and rendering performance.
- **Long tasks:** `mainThread.longTasksTotal` counts Chromium's [`longtask` entries](https://w3c.github.io/longtasks/) for work occupying the renderer for at least 50 ms. `longestTaskMs` records the longest task; `totalBlockingTimeMs` sums the portion of each task above 50 ms. `durationMs` records the measurement window. Finishing yields to the next task before draining the observer, so a freeze in the final callback is included. Tasks overlapping either phase boundary count in full; tasks entirely outside the window are excluded.

CI gates on long tasks, startup time and working set. It does **not** enforce a 20 ms frame-time guarantee. The old frame-gap and timer-gap counts are not comparable to the new long-task counts. Shorter rendering regressions still need frame analysis on a controlled display.

## Why the timing measurement changed

On September 28, a hosted runner reported 29 timer gaps over 20 ms during three seconds of idle time, versus nine during the ten-second bridge workload. Replacing animation-frame gaps with a 4 ms polling timer had retained the same fundamental problem: a delayed callback did not establish that renderer work had blocked the thread. One passing hosted run did not establish reliability.

An Electron regression test reproduces that distinction: delayed timer delivery without blocking work must report zero long tasks, while six deliberate 60 ms freezes must exceed the bridge's task-count budget. It also tests a freeze in the callback that finishes the measurement, and isolation between phases. CI runs this test with the repository's Electron version before benchmarking the app. Unsupported measurement APIs fail explicitly.

Long-task durations are still wall-clock measurements: CPU contention during an executing task can affect them. This removes timer wakeup and display cadence as stand-ins for renderer work; it does not make shared hardware a controlled performance lab. CI retains both workload logs as artifacts, including on failure, and runs the large-thread workload even if the bridge budget fails.

## Budgets

| Phase                                               | Budget        |
| --------------------------------------------------- | ------------- |
| Cold start                                          | 1,500 ms      |
| Five-run bridge workload, 10 seconds                | 5 long tasks  |
| Fifty-run scale workload, 8 seconds                 | 30 long tasks |
| Scale working set                                   | 1,500 MB      |
| Open large thread                                   | 1,500 ms      |
| Large thread receiving its own stream, 8 seconds    | 60 long tasks |
| Large thread while unrelated runs stream, 8 seconds | 10 long tasks |
| Longest task in any gated workload                  | 250 ms        |

The task-count caps retain the existing counts with the new explicit 50 ms definition. The separate 250 ms cap prevents a single severe freeze from passing merely because its count is small. Missing, non-finite or negative measurements fail. The idle report is diagnostic; it is not subtracted from a workload or used to raise its budget.

## Verification

Run the measurement regression and budget tests on a machine that can launch Electron:

```sh
node --test scripts/benchmark-measurement.test.cjs scripts/check-benchmark.test.cjs
```

CI and local runs use the same budget evaluator:

```sh
node scripts/check-benchmark.cjs bridge apps/desktop/bench.log
node scripts/check-benchmark.cjs thread apps/desktop/thread-bench.log
```
