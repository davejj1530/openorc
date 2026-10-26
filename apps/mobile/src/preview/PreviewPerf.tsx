import { useEffect, useRef } from "react";
import { report } from "../thread/perf-probe";
import { useFrameSampler } from "../thread/PerfProbe";
import { perfSeconds, previewScenario, startFrameWork, stopFrameWork } from "./preview-perf";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs the Preview's performance scenario once its first frame shows: a few seconds to settle, then the frames' JS
 * work and the UI thread's pacing for the run's length, with a mark each minute for memory read from outside. Draws
 * nothing.
 */
export function PreviewPerf({ shown }: { shown: boolean }) {
  const sampler = useFrameSampler();
  const started = useRef(false);
  const cancelled = useRef(false);
  useEffect(
    () => () => {
      cancelled.current = true;
    },
    [],
  );
  useEffect(() => {
    if (!shown || started.current || !previewScenario()) return;
    started.current = true;
    void (async () => {
      await wait(2000);
      if (cancelled.current) return;
      const seconds = perfSeconds();
      sampler.begin();
      startFrameWork();
      report("preview-start", { seconds });
      for (let second = 1; second <= seconds && !cancelled.current; second++) {
        await wait(1000);
        if (second % 60 === 0) report("preview-minute", { minute: second / 60 });
      }
      sampler.finish("preview", { seconds, ...stopFrameWork() });
    })();
  }, [shown, sampler]);
  return null;
}
