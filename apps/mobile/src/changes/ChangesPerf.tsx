import type { LegendListRef } from "@legendapp/list/react-native";
import { router } from "expo-router";
import { useEffect, useRef, type RefObject } from "react";
import { perfThread } from "../thread/perf-probe";
import { useFrameSampler } from "../thread/PerfProbe";
import { changesScenario, perfPath, reportChangesOpened, scrollToEnd } from "./changes-perf";
import type { ChangesReads } from "./use-changes";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Runs the Changes screen's performance scenario, once its first rows are on screen. Draws nothing. */
export function ChangesPerf({ reads, list }: { reads: ChangesReads; list: RefObject<LegendListRef | null> }) {
  const sampler = useFrameSampler();
  const files = reads.changes.data?.totals.files;
  const running = reads.thread.data?.activity === "running";
  const ran = useRef(false);
  const live = useRef<{ began: boolean; quietSince: number }>({ began: false, quietSince: 0 });
  useEffect(() => {
    if (files === undefined || ran.current) return;
    ran.current = true;
    reportChangesOpened(files);
    const scenario = changesScenario();
    if (scenario === "changes-scroll")
      void wait(2000).then(() =>
        scrollToEnd(sampler, "changes-scroll", () => {
          const state = list.current?.getState();
          if (!state || state.isAtEnd) return false;
          void list.current?.scrollToOffset({ offset: state.scroll + 600, animated: true });
          return true;
        }),
      );
    if (scenario === "diff-scroll") void wait(1500).then(() => router.push({ pathname: "/diff", params: { threadId: perfThread() ?? "", path: perfPath() ?? "", comparison: "head" } }));
  }, [files, list, sampler]);
  useEffect(() => {
    if (changesScenario() !== "changes-live") return;
    if (running && !live.current.began) {
      live.current.began = true;
      sampler.begin();
    }
    if (!running && live.current.began) {
      live.current.began = false;
      const timer = setTimeout(() => sampler.finish("changes-live", { files: reads.changes.data?.totals.files ?? 0 }), 500);
      return () => clearTimeout(timer);
    }
  }, [running, sampler, reads.changes.data?.totals.files]);
  return null;
}
