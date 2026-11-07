import "./diagram.css";
import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode, type Ref } from "react";
import type { DiagramNodeKind, LineSpan } from "@openorc/protocol";
import { RichText } from "../../components/RichText";
import { Button, IconButton, Tooltip } from "../../components/ui";
import { Expand, Minus, Plus, X } from "../../components/icons";
import { prefersReducedMotion } from "../../lib/motion";
import {
  arrowhead,
  clearOf,
  curveThrough,
  fitCamera,
  layoutDiagram,
  revealBox,
  startCamera,
  zoomAt,
  zoomRange,
  type Box,
  type Camera,
  type Diagram,
  type DiagramLayout,
  type Insets,
  type PlacedNode,
  type Point,
  type Size,
} from "./diagram-layout";

/** Room kept clear when fitting: the zoom controls sit in the bottom-left corner. */
const fitInsets: Insets = { top: 24, right: 24, bottom: 56, left: 24 };
const zoomStep = 1.25;
const arrowLength = 8;
/** The detail piece's width and its inset from the canvas edges; reveal keeps nodes clear of it. */
const detail = { width: 340, inset: 10 };
/** Parts blur away over --duration-leave, then the piece folds over --duration-arrive after a 60ms lead. */
const detailLeaveMs = 280;
const detailResize = { duration: 420, easing: "cubic-bezier(0.22, 1, 0.36, 1)" };
const revealMargin = 16;

/** Entry and output are the ends of the flow, decision a branch, data state, external a call outside the file. */
const kinds: Record<DiagramNodeKind, { mark: ReactNode; spoken: string | null }> = {
  entry: { spoken: "Start", mark: <circle cx="6" cy="6" r="3.25" fill="currentColor" stroke="none" /> },
  output: {
    spoken: "Result",
    mark: (
      <>
        <circle cx="6" cy="6" r="4.5" />
        <circle cx="6" cy="6" r="1.75" fill="currentColor" stroke="none" />
      </>
    ),
  },
  decision: { spoken: "Decision", mark: <path d="M6 1.25 10.75 6 6 10.75 1.25 6Z" /> },
  data: {
    spoken: "Data",
    mark: (
      <>
        <ellipse cx="6" cy="3.25" rx="4.25" ry="1.75" />
        <path d="M1.75 3.25v5.5c0 .97 1.9 1.75 4.25 1.75s4.25-.78 4.25-1.75v-5.5" />
      </>
    ),
  },
  external: { spoken: "Outside this file", mark: <path d="M3.5 8.5 8.5 3.5 M4.25 3.5H8.5v4.25" /> },
  step: { spoken: null, mark: null },
};

/** It opens at the start, readable; Fit shows the whole diagram; either follows resizes until the reader moves it. */
type CameraState = { mode: "start" | "fit"; glide: boolean } | { mode: "free"; camera: Camera; glide: boolean };

const placed = (state: CameraState, layout: DiagramLayout, viewport: Size): Camera => {
  if (state.mode === "free") return state.camera;
  return state.mode === "fit" ? fitCamera(layout.bounds, viewport, fitInsets) : startCamera(layout, viewport, fitInsets);
};

/** One node's detail at a time; a closing one stays mounted while its parts blur away. */
type DetailState = { id: string; leaving: boolean } | null;

function KindMark({ kind }: { kind: DiagramNodeKind }) {
  const { mark } = kinds[kind];
  if (!mark) return null;
  return (
    <svg
      className="explain-diagram-mark"
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.25}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {mark}
    </svg>
  );
}

function linesLabel({ start, end }: LineSpan): string {
  return start === end ? `Show line ${start}` : `Show lines ${start}–${end}`;
}

/** Where a revealed node may sit: above the zoom controls. */
function revealArea(viewport: Size): Box {
  return { x: 0, y: 0, width: viewport.width, height: viewport.height - fitInsets.bottom + revealMargin };
}

/** Where the detail piece will stand once it has grown to `height`, its content's natural height. */
function detailArea(viewport: Size, height: number): Box {
  const width = Math.min(detail.width, viewport.width - detail.inset * 2);
  return { x: viewport.width - detail.inset - width, y: detail.inset, width, height: Math.min(height, viewport.height - detail.inset * 2) };
}

function useViewportSize(element: HTMLElement | null): Size {
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });
  useLayoutEffect(() => {
    if (!element) return;
    const measure = () => setSize((was) => (was.width === element.clientWidth && was.height === element.clientHeight ? was : { width: element.clientWidth, height: element.clientHeight }));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return size;
}

/** The canvas camera. Direct manipulation moves at once; buttons and reveals glide. */
function useCamera(layout: DiagramLayout, element: HTMLElement | null) {
  const viewport = useViewportSize(element);
  const [state, setState] = useState<CameraState>({ mode: "start", glide: false });
  const [shownLayout, setShownLayout] = useState(layout);
  if (shownLayout !== layout) {
    setShownLayout(layout);
    setState({ mode: "start", glide: false });
  }
  const camera = placed(state, layout, viewport);
  const frame = useRef({ layout, viewport });
  useLayoutEffect(() => {
    frame.current = { layout, viewport };
  }, [layout, viewport]);

  const move = useCallback((next: (camera: Camera) => Camera, glide: boolean) => {
    setState((was) => {
      const from = placed(was, frame.current.layout, frame.current.viewport);
      const to = next(from);
      return to === from ? was : { mode: "free", camera: to, glide };
    });
  }, []);
  const zoomBy = useCallback((factor: number) => move((from) => zoomAt(from, factor, { x: frame.current.viewport.width / 2, y: frame.current.viewport.height / 2 }), true), [move]);
  const reveal = useCallback(
    (box: Box, detailHeight: number | null) =>
      move((from) => {
        const { viewport } = frame.current;
        const inside = revealBox(from, box, revealArea(viewport), revealMargin);
        return detailHeight === null ? inside : clearOf(inside, box, detailArea(viewport, detailHeight), revealArea(viewport), revealMargin);
      }, true),
    [move],
  );
  const fit = useCallback(() => setState({ mode: "fit", glide: true }), []);

  useEffect(() => {
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const unit = [1, 16, element.clientHeight][event.deltaMode] ?? 1;
      if (!event.ctrlKey && !event.metaKey) return move((from) => ({ ...from, x: from.x - event.deltaX * unit, y: from.y - event.deltaY * unit }), false);
      const rect = element.getBoundingClientRect();
      const delta = Math.max(-40, Math.min(40, event.deltaY * unit));
      move((from) => zoomAt(from, Math.exp(-delta * 0.01), { x: event.clientX - rect.left, y: event.clientY - rect.top }), false);
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [element, move]);

  return { camera, glide: state.glide, move, zoomBy, reveal, fit };
}

/** Dragging the background pans; a press that never moves is a click on the background. */
function useBackgroundDrag(camera: Camera, move: (next: (camera: Camera) => Camera, glide: boolean) => void, onTap: () => void) {
  const drag = useRef<{ pointer: number; start: Point; from: Camera; moved: boolean } | null>(null);
  const [panning, setPanning] = useState(false);
  const end = (event: PointerEvent<HTMLElement>, tapped: boolean) => {
    const current = drag.current;
    if (!current || current.pointer !== event.pointerId) return;
    drag.current = null;
    setPanning(false);
    if (tapped && !current.moved) onTap();
  };
  return {
    panning,
    onPointerDown: (event: PointerEvent<HTMLElement>) => {
      if (event.button !== 0 || (event.target as Element).closest("button")) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { pointer: event.pointerId, start: { x: event.clientX, y: event.clientY }, from: camera, moved: false };
    },
    onPointerMove: (event: PointerEvent<HTMLElement>) => {
      const current = drag.current;
      if (!current || current.pointer !== event.pointerId) return;
      const dx = event.clientX - current.start.x;
      const dy = event.clientY - current.start.y;
      if (!current.moved && Math.hypot(dx, dy) < 3) return;
      current.moved = true;
      setPanning(true);
      move(() => ({ ...current.from, x: current.from.x + dx, y: current.from.y + dy }), false);
    },
    onPointerUp: (event: PointerEvent<HTMLElement>) => end(event, true),
    onPointerCancel: (event: PointerEvent<HTMLElement>) => end(event, false),
  };
}

function DiagramEdges({ layout, selected }: { layout: DiagramLayout; selected: string | null }) {
  const touches = (edge: { from: string; to: string }) => selected !== null && (edge.from === selected || edge.to === selected);
  const ordered = [...layout.edges].sort((a, b) => Number(touches(a.edge)) - Number(touches(b.edge)));
  return (
    <>
      <svg className="explain-diagram-edges" width={layout.bounds.width} height={layout.bounds.height} aria-hidden="true">
        {ordered.map(({ id, edge, points }) => (
          <g key={id} data-active={touches(edge) || undefined}>
            <path className="explain-diagram-edge" d={curveThrough(points, arrowLength)} />
            <path className="explain-diagram-arrow" d={arrowhead(points, arrowLength)} />
          </g>
        ))}
      </svg>
      {layout.edges.map(({ id, edge, label }) =>
        label ? (
          <span
            key={id}
            className="explain-diagram-edge-label"
            data-active={touches(edge) || undefined}
            style={{ left: label.box.x + label.box.width / 2, top: label.box.y + label.box.height / 2, maxWidth: label.box.width }}
          >
            {label.text}
          </span>
        ) : null,
      )}
    </>
  );
}

interface NodeHandlers {
  onToggle: (placed: PlacedNode) => void;
  onFocus: (placed: PlacedNode) => void;
  register: (id: string, button: HTMLButtonElement) => () => void;
}

function DiagramNodeButton({ placed, open, detailId, handlers }: { placed: PlacedNode; open: boolean; detailId: string; handlers: NodeHandlers }) {
  const descriptionId = useId();
  const { node, box } = placed;
  const spoken = kinds[node.kind].spoken;
  return (
    <button
      ref={(button) => (button ? handlers.register(node.id, button) : undefined)}
      type="button"
      className="explain-diagram-node focus-ring"
      data-kind={node.kind}
      aria-label={node.label}
      aria-describedby={descriptionId}
      aria-expanded={open}
      aria-controls={open ? detailId : undefined}
      style={{ left: box.x, top: box.y, width: box.width, height: box.height }}
      onClick={() => handlers.onToggle(placed)}
      onFocus={() => handlers.onFocus(placed)}
    >
      <span className="explain-diagram-node-head">
        <KindMark kind={node.kind} />
        <span className="explain-diagram-node-label">{node.label}</span>
      </span>
      <span id={descriptionId} className="explain-diagram-node-summary">
        {spoken && <span className="sr-only">{spoken}. </span>}
        {node.summary}
      </span>
    </button>
  );
}

const DiagramWorld = memo(function DiagramWorld({ layout, selected, detailId, handlers }: { layout: DiagramLayout; selected: string | null; detailId: string; handlers: NodeHandlers }) {
  return (
    <>
      <DiagramEdges layout={layout} selected={selected} />
      {layout.nodes.map((placed) => (
        <DiagramNodeButton key={placed.node.id} placed={placed} open={placed.node.id === selected} detailId={detailId} handlers={handlers} />
      ))}
    </>
  );
});

function ZoomControls({ k, onZoom, onFit }: { k: number; onZoom: (factor: number) => void; onFit: () => void }) {
  return (
    <div className="explain-diagram-zoom" role="group" aria-label="Zoom">
      <Tooltip label="Zoom out">
        <IconButton size="sm" aria-label="Zoom out" disabled={k <= zoomRange.min} onClick={() => onZoom(1 / zoomStep)}>
          <Minus size={16} />
        </IconButton>
      </Tooltip>
      <Tooltip label="Zoom in">
        <IconButton size="sm" aria-label="Zoom in" disabled={k >= zoomRange.max} onClick={() => onZoom(zoomStep)}>
          <Plus size={16} />
        </IconButton>
      </Tooltip>
      <Tooltip label="Fit to view">
        <IconButton size="sm" aria-label="Fit to view" onClick={onFit}>
          <Expand size={15} />
        </IconButton>
      </Tooltip>
    </div>
  );
}

interface DetailProps {
  placed: PlacedNode;
  id: string;
  leaving: boolean;
  refs: { shell: Ref<HTMLElement>; head: Ref<HTMLElement>; body: Ref<HTMLDivElement> };
  onClose: () => void;
  onShowLines: (lines: LineSpan) => void;
}

function DiagramDetail({ placed: { node }, id, leaving, refs, onClose, onShowLines }: DetailProps) {
  const titleId = useId();
  const lines = node.lines;
  return (
    <section
      ref={refs.shell}
      id={id}
      className="explain-diagram-detail"
      data-plane=""
      data-leaving={leaving || undefined}
      aria-hidden={leaving || undefined}
      inert={leaving}
      aria-labelledby={titleId}
      style={{ width: `min(${detail.width}px, calc(100% - ${detail.inset * 2}px))`, top: detail.inset, right: detail.inset, maxHeight: `calc(100% - ${detail.inset * 2}px)` }}
    >
      <div key={node.id} className="explain-diagram-detail-content">
        <header ref={refs.head} className="explain-diagram-detail-head motion-arrive">
          <KindMark kind={node.kind} />
          <h3 id={titleId} className="explain-diagram-detail-title">
            {node.label}
          </h3>
          <Tooltip label="Close">
            <IconButton size="xs" aria-label="Close" onClick={onClose}>
              <X size={14} />
            </IconButton>
          </Tooltip>
        </header>
        <div ref={refs.body} className="explain-diagram-detail-body">
          <p className="explain-diagram-detail-summary motion-arrive">{node.summary}</p>
          <div className="explain-diagram-detail-markdown prose-chat motion-arrive">
            <RichText mode="static">{node.detail}</RichText>
          </div>
          {lines && (
            <div className="explain-diagram-detail-action motion-arrive">
              <Button size="sm" onClick={() => onShowLines(lines)}>
                {linesLabel(lines)}
              </Button>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

/** Switching nodes keeps the piece and swaps its parts; the piece follows the new height instead of jumping to it. */
function useDetailPresence(layout: DiagramLayout) {
  const [state, setState] = useState<DetailState>(null);
  const [shownLayout, setShownLayout] = useState(layout);
  if (shownLayout !== layout) {
    setShownLayout(layout);
    setState(null);
  }
  const shell = useRef<HTMLElement>(null);
  const head = useRef<HTMLElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const switchedFrom = useRef<number | null>(null);
  useEffect(() => {
    if (!state?.leaving) return;
    const timer = setTimeout(() => setState((was) => (was?.leaving ? null : was)), prefersReducedMotion() ? 0 : detailLeaveMs);
    return () => clearTimeout(timer);
  }, [state]);
  useLayoutEffect(() => {
    const from = switchedFrom.current;
    switchedFrom.current = null;
    if (!shell.current || from === null || prefersReducedMotion()) return;
    const to = shell.current.getBoundingClientRect().height;
    if (Math.abs(to - from) >= 1) shell.current.animate([{ height: `${from}px` }, { height: `${to}px` }], detailResize);
  }, [state?.id]);
  const open = state && !state.leaving ? state.id : null;
  const show = useCallback(
    (id: string) => {
      if (open !== null && open !== id) switchedFrom.current = shell.current?.getBoundingClientRect().height ?? null;
      setState({ id, leaving: false });
    },
    [open],
  );
  const close = useCallback(() => setState((was) => (was && !was.leaving ? { id: was.id, leaving: true } : was)), []);
  /** The height the piece grows to, read from its parts so a grow or fold under way does not shorten it. */
  const naturalHeight = useCallback(() => (head.current?.offsetHeight ?? 0) + (body.current?.scrollHeight ?? 0), []);
  return { state, open, show, close, naturalHeight, refs: { shell, head, body } };
}

/** A pannable, zoomable canvas of the file's logic; opening a node explains it beside the diagram. */
export function DiagramView({ diagram, onShowLines }: { diagram: Diagram; onShowLines: (lines: LineSpan) => void }) {
  const layout = useMemo(() => layoutDiagram(diagram), [diagram]);
  const [canvas, setCanvas] = useState<HTMLDivElement | null>(null);
  const { camera, glide, move, zoomBy, reveal, fit } = useCamera(layout, canvas);
  const presence = useDetailPresence(layout);
  const { open, show, close, naturalHeight, refs } = presence;
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const detailId = useId();

  const closeDetail = useCallback(() => {
    const id = presence.state?.id;
    if (id && refs.shell.current?.contains(document.activeElement)) buttons.current.get(id)?.focus();
    close();
  }, [presence.state?.id, refs.shell, close]);
  const handlers = useMemo<NodeHandlers>(
    () => ({
      onToggle: ({ node }) => {
        if (open === node.id) {
          close();
          return;
        }
        show(node.id);
      },
      onFocus: ({ box }) => reveal(box, open === null ? null : naturalHeight()),
      register: (id, button) => {
        buttons.current.set(id, button);
        return () => buttons.current.delete(id);
      },
    }),
    [open, show, close, reveal, naturalHeight],
  );
  const opened = open === null ? undefined : layout.nodes.find((placed) => placed.node.id === open);
  useLayoutEffect(() => {
    if (opened) reveal(opened.box, naturalHeight());
  }, [opened, reveal, naturalHeight]);
  const { panning, ...dragHandlers } = useBackgroundDrag(camera, move, close);
  const shown = presence.state && layout.nodes.find((placed) => placed.node.id === presence.state?.id);
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || open === null) return;
    event.stopPropagation();
    closeDetail();
  };

  return (
    <div className="explain-diagram" onKeyDown={onKeyDown}>
      <p className="explain-diagram-summary">{diagram.summary}</p>
      <div className="explain-diagram-well">
        <div ref={setCanvas} className="explain-diagram-canvas" role="group" aria-label="Diagram" data-panning={panning || undefined} {...dragHandlers}>
          <div className="explain-diagram-world" data-glide={glide || undefined} style={{ transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.k})` }}>
            <DiagramWorld layout={layout} selected={open} detailId={detailId} handlers={handlers} />
          </div>
        </div>
        <ZoomControls k={camera.k} onZoom={zoomBy} onFit={fit} />
        {shown && <DiagramDetail placed={shown} id={detailId} leaving={presence.state?.leaving ?? false} refs={refs} onClose={closeDetail} onShowLines={onShowLines} />}
      </div>
    </div>
  );
}
