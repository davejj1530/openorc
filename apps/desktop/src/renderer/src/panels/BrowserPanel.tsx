import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { flushSync } from "react-dom";
import type { BrowserPaneState, PaneRect } from "../../../shared/types";
import { ArrowLeft, ArrowRight, Globe, RefreshCw } from "../components/icons";
import { Button, Empty, IconButton, Input } from "../components/ui";
import { isPreviewCovered, usePreviewCovered } from "../lib/browser-preview";

const starting = (url: string): BrowserPaneState => ({ url, title: "", canGoBack: false, canGoForward: false, loading: true, error: null });

/** Resolves a frame after the next one, by which point the next one is on screen. */
const painted = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

/**
 * An address typed in a hurry is a local one abbreviated. Anything with a
 * scheme goes to the pane's policy exactly as written. An empty field is not
 * an abbreviation of anything, hence the null: it is the one value that has no
 * address in it at all.
 */
export function typedUrl(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
}

/** Still frames that end the follow. It only has to outlast a dropped frame: a live transition keeps producing changes of its own. */
const settleFrames = 6;

function previewStateContent(state: BrowserPaneState, draft: string, reload: () => void): ReactNode {
  if (state.error !== null) {
    return (
      <Empty
        title="Could not load the preview"
        icon={<Globe size={20} />}
        action={
          <Button size="sm" onClick={reload}>
            Retry
          </Button>
        }
      >
        {state.error}
      </Empty>
    );
  }
  if (state.loading) {
    return (
      <p role="status" className="h-full grid place-items-center px-6 text-base text-ink-3">
        <span className="max-w-full truncate">Loading {state.url || draft}…</span>
      </p>
    );
  }
  return null;
}

/**
 * The website preview. The page is a WebContentsView the main process
 * composites above this panel, so everything here is chrome plus the rectangle
 * that says where the page goes. The view does not clip to the panel and does
 * not honour `inert`, which is why the rect is pushed on every move and the
 * view is hidden the moment this unmounts. Nothing the app draws can pass over
 * it either, so while a dialog or menu is open a still of the page stands in.
 */
export function BrowserPanel({ id, defaultUrl, onUrl }: { id: string; defaultUrl: string; onUrl?: (url: string) => void }) {
  const [state, setState] = useState<BrowserPaneState>(() => starting(defaultUrl));
  const [draft, setDraft] = useState(defaultUrl);
  /** A frame of the page, standing in for the view while a dialog or menu is over it. */
  const [still, setStill] = useState<string | null>(null);
  const covered = usePreviewCovered();
  const host = useRef<HTMLDivElement | null>(null);
  const stillImage = useRef<HTMLImageElement | null>(null);
  const sent = useRef<PaneRect | null>(null);
  const frame = useRef(0);
  const typing = useRef(false);
  /** Whether main has been told to paint the view. Not whether it has: a loading page is held back there. */
  const revealed = useRef(false);
  const report = useRef(onUrl);
  report.current = onUrl;
  const reported = useRef<string | null>(null);

  const measure = useCallback((): PaneRect | null => {
    const node = host.current;
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
  }, []);

  /**
   * Put the view back on screen at wherever the placeholder is now. Re-showing
   * is how a pane hidden by an error or a floating layer comes back. A still
   * comes down only once the view is over it again, so the swap has no gap.
   */
  const reveal = useCallback(() => {
    const bounds = measure();
    // A layer over the preview holds the view back; uncovering reveals it.
    if (!bounds || isPreviewCovered()) return;
    sent.current = bounds;
    revealed.current = true;
    void window.openorc.browser
      .show({ id, bounds })
      .catch(() => undefined)
      .then(painted)
      .then(() => {
        if (!isPreviewCovered()) setStill(null);
      });
  }, [id, measure]);

  /**
   * Trade the live page for a still of itself, painted before the view leaves
   * so the rectangle is never empty. Every step re-checks the cover: a layer
   * that closes mid-swap leaves the view where it is, and the reveal its
   * closing triggers takes over from there.
   */
  const standIn = useCallback(async () => {
    const browser = window.openorc.browser;
    // Null while nothing is on screen, a page still loading say. Hiding then
    // only keeps that load from landing on top of the layer.
    const image = await browser.capture(id).catch(() => null);
    if (!isPreviewCovered()) return;
    if (image !== null) {
      flushSync(() => setStill(image));
      await stillImage.current?.decode().catch(() => undefined);
      await painted();
      if (!isPreviewCovered()) return;
    }
    browser.hide(id);
  }, [id]);

  useEffect(() => {
    let cancelled = false;
    const pane = window.openorc.browser;
    const off = pane.onState(id, (next) => {
      if (!cancelled) setState(next);
    });
    const bounds = measure();
    if (bounds) {
      sent.current = bounds;
      revealed.current = true;
      void pane.show({ id, bounds, url: defaultUrl }).then(
        (next) => {
          if (!cancelled) setState(next);
        },
        (error: unknown) => {
          if (!cancelled) setState({ ...starting(defaultUrl), loading: false, error: error instanceof Error ? error.message : String(error) });
        },
      );
    }
    return () => {
      cancelled = true;
      off();
      sent.current = null;
      revealed.current = false;
      // Hidden, never closed: the page keeps running, so leaving this tab and
      // coming back does not restart the dev server's client.
      pane.hide(id);
    };
  }, [id, defaultUrl, measure]);

  useEffect(() => {
    const node = host.current;
    if (!node) return;
    let settled = 0;
    const push = (): boolean => {
      const bounds = measure();
      if (!bounds) return false;
      const last = sent.current;
      if (last && last.x === bounds.x && last.y === bounds.y && last.width === bounds.width && last.height === bounds.height) return false;
      sent.current = bounds;
      window.openorc.browser.setBounds(id, bounds);
      return true;
    };
    // ResizeObserver catches the panel being dragged wider. The frame loop
    // catches what it cannot see: the column sliding open and the sidebar
    // resizing beside it both move this element without resizing it.
    const follow = () => {
      cancelAnimationFrame(frame.current);
      settled = 0;
      const step = () => {
        settled = push() ? 0 : settled + 1;
        if (settled < settleFrames) frame.current = requestAnimationFrame(step);
      };
      frame.current = requestAnimationFrame(step);
    };
    const observer = new ResizeObserver(follow);
    observer.observe(node);
    // Capture phase: a scroll inside an ancestor moves the pane, and a
    // scrolling container's event never reaches window on its own. It also
    // brings every other scroller in the app with it, so the pane only
    // measures when it sits inside whatever scrolled. Without that test a
    // streaming transcript restarts this loop, and posts bounds again, on
    // every frame it grows.
    const scrolled = (event: Event) => {
      const target = event.target;
      if (target instanceof Node && target.contains(node)) follow();
    };
    window.addEventListener("scroll", scrolled, true);
    window.addEventListener("resize", follow);
    follow();
    return () => {
      cancelAnimationFrame(frame.current);
      observer.disconnect();
      window.removeEventListener("scroll", scrolled, true);
      window.removeEventListener("resize", follow);
    };
  }, [id, measure]);

  // The view is composited above this panel rather than inside it, so it has
  // to give the rectangle back whenever something else must show there: a
  // failure, whose Retry an empty page would swallow, or a dialog or menu,
  // which no z-index lifts over the view. Handing it back means asking for it
  // again once the reason clears, which nothing else does, and `revealed` is
  // what keeps that to the one push that clears it rather than every push
  // that arrives while a page streams.
  useEffect(() => {
    if (state.error === null && !covered) {
      if (!revealed.current) reveal();
      return;
    }
    // Uncovered onto a failure: no view is coming back over the still.
    if (!covered) setStill(null);
    if (!revealed.current) return;
    revealed.current = false;
    if (covered) void standIn();
    else window.openorc.browser.hide(id);
  }, [id, state.error, covered, reveal, standIn]);

  // The field follows the page except while someone is typing into it.
  useEffect(() => {
    if (typing.current || !state.url || state.url === "about:blank") return;
    setDraft(state.url);
    // Where the reader actually went, so the next visit starts there rather
    // than at a port the app guessed. Held in a ref and guarded on the value
    // because the caller writes this to a store it also reads: depending on
    // the callback's identity, or re-reporting an unchanged url, would make
    // the parent's re-render feed straight back into this effect.
    if (reported.current === state.url) return;
    reported.current = state.url;
    report.current?.(state.url);
  }, [state.url]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const next = typedUrl(draft);
    // An empty field would build http:// and come back as a refusal naming
    // nothing. Asking for nothing asks for nothing.
    if (next === null) return;
    typing.current = false;
    setDraft(next);
    reveal();
    window.openorc.browser.navigate(id, next);
  };
  // Every history move re-reveals first: the pane may be hidden behind an
  // error message, and the page it is going to is probably not the one that
  // failed.
  const back = () => {
    reveal();
    window.openorc.browser.goBack(id);
  };
  const forward = () => {
    reveal();
    window.openorc.browser.goForward(id);
  };
  const reload = () => {
    reveal();
    window.openorc.browser.reload(id);
  };
  const previewStatus = previewStateContent(state, draft, reload);

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="h-10 shrink-0 flex items-center gap-1 px-3 border-b border-line">
        <IconButton size="sm" aria-label="Back" disabled={!state.canGoBack} onClick={back}>
          <ArrowLeft size={12} />
        </IconButton>
        <IconButton size="sm" aria-label="Forward" disabled={!state.canGoForward} onClick={forward}>
          <ArrowRight size={12} />
        </IconButton>
        <IconButton size="sm" aria-label="Reload" onClick={reload}>
          <RefreshCw size={12} className={state.loading ? "animate-spin" : ""} />
        </IconButton>
        <form className="flex-1 min-w-0 ml-1" onSubmit={submit}>
          <Input
            value={draft}
            onChange={(e) => {
              typing.current = true;
              setDraft(e.target.value);
            }}
            onBlur={() => {
              typing.current = false;
            }}
            aria-label="Preview address"
            placeholder="http://localhost:3000"
            spellCheck={false}
            autoComplete="off"
            className="h-7 font-mono text-sm"
          />
        </form>
      </div>
      <div ref={host} className="relative flex-1 min-h-0">
        {previewStatus}
        {still !== null ? <img ref={stillImage} src={still} alt="" draggable={false} className="absolute inset-0 size-full object-cover object-top-left" /> : null}
      </div>
    </div>
  );
}
