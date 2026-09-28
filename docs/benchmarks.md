# Desktop benchmarks

The CI Bridge benchmark job builds the desktop app with `OPENORC_QA_BUILD=1`, then runs the bridge/scale and large-thread autoruns. Release builds omit these autoruns.

The two benchmark modes disable [background throttling](https://www.electronjs.org/docs/latest/api/structures/web-preferences) so covering the QA window does not pause its timers or animation frames mid-workload. Other launches retain Electron's default background throttling.

Each phase records two separate timing signals:

- **Animation frames:** `longFramesTotal` counts `requestAnimationFrame` gaps over 20 ms, and `longestFrameMs` records the longest gap. These remain in the reports for diagnosing display and rendering performance.
- **Renderer responsiveness:** `mainThread` samples the renderer with a 4 ms timer during the phase. `stallsTotal` counts sample gaps over 20 ms, including a delayed final sample; `longestGapMs`, `samples`, and `durationMs` describe the measurement. The timer stops between phases.

CI enforces renderer responsiveness. Animation frames depend on the display's refresh clock, so a hosted runner can report slow frames while the main thread is available. For example, the idle phase on September 28 recorded 33 slow frames in three seconds before receiving any benchmark events. An independent timer avoids that display dependency while still detecting renderer freezes and CPU scheduling delays. It does not measure compositor/GPU-only stalls; use the animation-frame reports on a stable display for that investigation.

| Phase                                               | Budget                |
| --------------------------------------------------- | --------------------- |
| Cold start                                          | 1,500 ms              |
| Five-run bridge workload, 10 seconds                | 5 main-thread stalls  |
| Fifty-run scale workload, 8 seconds                 | 30 main-thread stalls |
| Scale working set                                   | 1,500 MB              |
| Open large thread                                   | 1,500 ms              |
| Large thread receiving its own stream, 8 seconds    | 60 main-thread stalls |
| Large thread while unrelated runs stream, 8 seconds | 10 main-thread stalls |

Missing measurement fields fail the check. The idle report includes both timing signals so runner noise can be compared with workload measurements; it is not subtracted from the workload or used to raise its budget.
