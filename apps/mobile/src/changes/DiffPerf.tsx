import { useEffect, useRef, type RefObject } from "react";
import type { ScrollViewInstance } from "react-native";
import { useFrameSampler } from "../thread/PerfProbe";
import { changesScenario, scrollToEnd } from "./changes-perf";

/** The diff-scroll scenario: the diff scrolled to its end a screen at a time once it drew. Draws nothing. */
export function DiffPerf({ ready, scroller, view, content }: { ready: boolean; scroller: RefObject<ScrollViewInstance | null>; view: () => { top: number; height: number }; content: () => number }) {
  const sampler = useFrameSampler();
  const ran = useRef(false);
  useEffect(() => {
    if (!ready || ran.current || changesScenario() !== "diff-scroll") return;
    ran.current = true;
    const timer = setTimeout(
      () =>
        void scrollToEnd(sampler, "diff-scroll", () => {
          const { top, height } = view();
          if (top + height >= content() - 1) return false;
          scroller.current?.scrollTo({ y: top + 600, animated: true });
          return true;
        }),
      2000,
    );
    return () => clearTimeout(timer);
  }, [ready, sampler, scroller, view, content]);
  return null;
}
