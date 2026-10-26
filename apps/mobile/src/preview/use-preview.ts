import type { PreviewFrame, PreviewPace, PreviewState } from "@openorc/protocol";
import { useIsFocused } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, useWindowDimensions } from "react-native";
import { fromByteArray } from "react-native-quick-base64";
import { link, useLinkState } from "../client";
import { DROPPED } from "../connection/link-connection";
import { timeConvert } from "./preview-perf";

/** A frame the phone holds, in memory only, and the tab it shows. */
export interface PreviewImage {
  seq: number;
  uri: string;
  width: number;
  height: number;
  pane: string;
}

/** Frames come at twice the view's points, twice again for a pinch past this; the Mac caps a tailnet route lower. */
const DEEP_ZOOM = 1.75;
const MIN_WIDTH = 320;
const MAX_WIDTH = 1600;

const watchWidth = (points: number, deep: boolean) => Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(points * 2 * (deep ? 2 : 1))));

/** The screen whose watch is the session's, as a newer one replaces it on the Mac: only that one ends it. */
let watching: symbol | null = null;

/** Whether the app is in front: `inactive` counts as away, so the App Switcher snapshot holds no frame. */
function useForeground(): boolean {
  const [active, setActive] = useState(AppState.currentState === "active");
  useEffect(() => AppState.addEventListener("change", (state) => setActive(state === "active")).remove, []);
  return active;
}

/** A failed fetch is asked again after this long, doubling to the last while it keeps failing. */
const RETRY_MS = [500, 1000, 2000, 4000];

type Due = PreviewFrame & { pane: string };

/**
 * Fetches a watched Preview's frames one at a time, the newest announced next: a finished fetch is the Mac's credit
 * for the next capture, so a slow link lowers the rate instead of queueing. The Mac captures nothing more until the
 * frame it named is fetched, so a fetch that fails (the session's image streams all busy, say) is asked again.
 */
class FrameFetcher {
  private due: Due | null = null;
  private asking: number | null = null;
  private shown = 0;
  private failures = 0;
  private retry: ReturnType<typeof setTimeout> | null = null;
  /** Counts cancels, so a fetch that finishes after one shows nothing. */
  private generation = 0;
  private stopped = false;

  constructor(
    private readonly threadId: string,
    private readonly show: (image: PreviewImage) => void,
  ) {}

  /** A frame the Mac told of; `owed` is the watch's answer, fetched even when shown, as that gives the credit back. */
  offer(frame: PreviewFrame, pane: string, owed: boolean): void {
    if (!owed && frame.seq <= Math.max(this.shown, this.asking ?? 0, this.due?.seq ?? 0)) return;
    this.due = { ...frame, pane };
    void this.pump();
  }

  cancel(): void {
    this.due = null;
    this.generation++;
    this.clearRetry();
  }

  stop(): void {
    this.stopped = true;
    this.due = null;
    this.clearRetry();
  }

  private clearRetry(): void {
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
  }

  private async pump(): Promise<void> {
    const next = this.due;
    if (this.busy() || !next || this.stopped) return;
    this.due = null;
    this.asking = next.seq;
    const generation = this.generation;
    try {
      const { bytes } = await link.connection.asset({ kind: "preview", threadId: this.threadId, seq: next.seq });
      if (this.stopped || generation !== this.generation) return;
      this.failures = 0;
      this.shown = Math.max(this.shown, next.seq);
      const uri = timeConvert(bytes, () => `data:image/jpeg;base64,${fromByteArray(bytes)}`);
      this.show({ seq: next.seq, uri, width: next.width, height: next.height, pane: next.pane });
    } catch {
      // Dropped with its session, the next watch's answer names a frame again; refused, the same one is asked again.
      if (!this.stopped && generation === this.generation) this.later(next);
    } finally {
      this.asking = null;
      void this.pump();
    }
  }

  private busy(): boolean {
    return this.asking !== null || this.retry !== null;
  }

  /** The frame again, unless something newer comes first. */
  private later(frame: Due): void {
    const wait = RETRY_MS[Math.min(this.failures++, RETRY_MS.length - 1)]!;
    this.retry = setTimeout(() => {
      this.retry = null;
      if (!this.due && frame.seq > this.shown) this.due = frame;
      void this.pump();
    }, wait);
  }
}

/**
 * A thread's Preview as the Mac shows it, watched while the screen is in front, the app is active and the link is up,
 * and again on every new session. Frames are never cached: the screen holds the newest in memory and drops it on blur
 * and when the app leaves the front.
 */
export function usePreview(threadId: string) {
  const focused = useIsFocused();
  const active = useForeground();
  const linkState = useLinkState();
  const serial = linkState.kind === "connected" ? linkState.serial : null;
  const pace: PreviewPace = linkState.kind === "connected" ? linkState.route.kind : "lan";
  const { width: points } = useWindowDimensions();
  const [deep, setDeep] = useState(false);
  const width = watchWidth(points, deep);
  const live = focused && active;
  const [state, setState] = useState<PreviewState>();
  const [refused, setRefused] = useState<string | null>(null);
  const [frame, setFrame] = useState<PreviewImage | null>(null);
  const fetcher = useRef<FrameFetcher | null>(null);
  const mine = useRef<symbol | null>(null);
  const connected = useRef(serial !== null);
  connected.current = serial !== null;

  useEffect(() => {
    if (!live) setFrame(null);
  }, [live]);

  // One fetcher per session: a fetch in flight when a session drops fails with it.
  useEffect(() => {
    if (!live || serial === null) return;
    const current = new FrameFetcher(threadId, setFrame);
    fetcher.current = current;
    return () => current.stop();
  }, [threadId, live, serial]);

  useEffect(() => {
    if (!live || serial === null) return;
    let current = true;
    const me = Symbol(threadId);
    watching = me;
    mine.current = me;
    link.connection.session("preview.watch", { threadId, width, pace }).then(
      (answer) => {
        if (!current) return;
        setRefused(null);
        setState(answer);
        if (answer.open && answer.frame) fetcher.current?.offer(answer.frame, answer.pane, true);
      },
      (error: Error) => current && error.message !== DROPPED && setRefused(error.message),
    );
    return () => {
      current = false;
    };
  }, [threadId, live, serial, width, pace]);

  // Covered, away or gone: the watch ends. A new session or a wider frame replaces it without ending it.
  useEffect(() => {
    if (!live) return;
    return () => {
      if (!connected.current || watching === null || watching !== mine.current) return;
      watching = null;
      void link.connection.session("preview.unwatch", {}).catch(() => undefined);
    };
  }, [live]);

  useEffect(
    () =>
      link.connection.onPreview((push) => {
        if (push.threadId !== threadId) return;
        // The Mac ended the watch (the thread was deleted): its words, as for a watch it refuses.
        if (push.type === "preview.ended") {
          fetcher.current?.cancel();
          setFrame(null);
          setState({ open: false });
          setRefused(push.message);
          return;
        }
        setState(push.state);
        if (!push.state.open) {
          fetcher.current?.cancel();
          setFrame(null);
        } else if (push.state.frame && connected.current) fetcher.current?.offer(push.state.frame, push.state.pane, false);
      }),
    [threadId],
  );

  const onZoom = useCallback((scale: number, settled: boolean) => {
    if (settled) setDeep(scale > DEEP_ZOOM);
  }, []);
  return { state, refused, frame, connected: serial !== null, active, onZoom };
}
