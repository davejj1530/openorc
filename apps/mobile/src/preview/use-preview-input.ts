import type { PreviewFocus, PreviewInput } from "@openorc/protocol";
import { useEffect, useMemo, useRef, useState } from "react";
import { link } from "../client";
import { haptic } from "../ui/haptics";
import type { FramePoint } from "./frame-fit";
import { InputQueue, type InputTarget } from "./input-queue";
import type { PreviewImage } from "./use-preview";

/** A second tap this soon and this close (in frame pixels) to the first is a double click, as on a Mac. */
const DOUBLE_TAP_MS = 350;
const DOUBLE_TAP_PX = 24;
/** A refusal's words stay in the header this long. */
const NOTICE_MS = 2_000;

type Tap = { at: number; x: number; y: number; count: number };

/** A tap's click count: the next of a run of taps on one spot, up to a triple click. */
function clickCount(last: Tap | null, point: FramePoint, now: number): number {
  if (!last || now - last.at > DOUBLE_TAP_MS || Math.hypot(point.x - last.x, point.y - last.y) > DOUBLE_TAP_PX) return 1;
  return Math.min(3, last.count + 1);
}

/** Whether an input that lands on a field starts a new one there: a tap, Tab or Enter may move the focus; typing does not. */
const movesFocus = (input: PreviewInput) => input.kind === "tap" || (input.kind === "key" && input.key !== "Backspace");

/**
 * The person's hands on the Mac's Preview: taps, drags, typing and choices for the pane the shown frame is of, sent one
 * at a time, and the Mac's focus after each, which raises the keyboard or a select's choices. `field` counts the times
 * the phone's field starts empty: each field the focus moved to, and each refusal.
 */
export function usePreviewInput(threadId: string, frame: PreviewImage | null) {
  const [focus, setFocus] = useState<PreviewFocus | null>(null);
  const [field, setField] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const target: InputTarget | null = frame ? { pane: frame.pane, frame: { width: frame.width, height: frame.height } } : null;
  const shown = useRef(target);
  shown.current = target;
  const lastTap = useRef<Tap | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const queue = useMemo(
    () =>
      new InputQueue({
        send: ({ target: { pane, frame: size }, input }) => link.connection.session("preview.input", { threadId, pane, frame: size, input }),
        onFocus: (next, input) => {
          // A choice made closes the choices; the select keeps the Mac's focus, and a tap on it opens them again.
          if (input.kind === "choose") return setFocus(null);
          setFocus(next);
          if (next?.kind === "text" && movesFocus(input)) setField((count) => count + 1);
        },
        onRefused: (message, tell) => {
          // What waited was dropped, typing too: the phone's field starts over rather than hold text the Mac never got.
          setField((count) => count + 1);
          if (!tell) return;
          haptic.warn();
          setNotice(message);
          if (noticeTimer.current) clearTimeout(noticeTimer.current);
          noticeTimer.current = setTimeout(() => setNotice(null), NOTICE_MS);
        },
      }),
    [threadId],
  );

  // Another tab, or no frame at all: what waits and the focus were for a page that is not shown.
  const pane = frame?.pane ?? null;
  useEffect(() => {
    queue.clear();
    setFocus(null);
  }, [queue, pane]);
  useEffect(
    () => () => {
      queue.clear();
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
    },
    [queue],
  );

  const actions = useMemo(() => {
    const send = (input: PreviewInput) => {
      if (shown.current) queue.push(shown.current, input);
    };
    return {
      tap(point: FramePoint) {
        const now = Date.now();
        const count = clickCount(lastTap.current, point, now);
        lastTap.current = { at: now, ...point, count };
        send({ kind: "tap", ...point, count });
      },
      /** The page scrolls by `dx`, `dy` frame pixels, at `point`. */
      scroll(point: FramePoint, dx: number, dy: number) {
        send({ kind: "scroll", ...point, dx, dy });
      },
      type(inputs: PreviewInput[]) {
        inputs.forEach(send);
      },
      choose(index: number) {
        haptic.select();
        setFocus(null);
        send({ kind: "choose", index });
      },
      /** The keyboard went away, or the choices were dismissed: the Mac keeps its focus, the phone lets go. */
      release() {
        setFocus(null);
      },
    };
  }, [queue]);
  return { focus, field, notice, ...actions };
}
