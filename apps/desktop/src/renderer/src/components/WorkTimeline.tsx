import { useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { workObjects, workTimeline, type Block, type Timeline, type TimelineLane, type TimelineStep, type WorkEntry, objectVerb } from "@openorc/client";
import { FileGlyph } from "./FileGlyph";
import { ActRow } from "./WorkActs";
import type { RenderBlocks } from "./WorkMarks";
import "./WorkTimeline.css";

/** The keys that move along the turn, and which way. */
const STEPS: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1 };

/** A lane's height, the room on the left for the first lanes' names, and how far apart steps may sit. */
const ROW = 28;
const LEFT = 128;
const RIGHT = 14;
const STEP = { min: 8, max: 56 };

interface Shape {
  x: (column: number) => number;
  y: (lane: number) => number;
  /** The column the turn ends at, where the lanes it edited come back in; null while it runs. */
  end: number | null;
  width: number;
}

/** A step sits one column past its index: column 0 is where the turn began. */
const column = (step: number) => step + 1;

function shapeOf(timeline: Timeline, width: number, live: boolean): Shape {
  const columns = timeline.steps.length + (live ? 0 : 1);
  const gap = Math.max(STEP.min, Math.min(STEP.max, (width - LEFT - RIGHT) / Math.max(1, columns)));
  return { x: (at) => LEFT + at * gap, y: (lane) => ROW / 2 + lane * ROW, end: live ? null : columns, width: Math.max(width, LEFT + columns * gap + RIGHT) };
}

/** A lane's line: off the turn's line where it was found, along its visits, and back in at the end when edited. */
function lanePath(lane: TimelineLane, index: number, { x, y, end }: Shape): string {
  const from = column(lane.from);
  const bend = (x(from + 1) - x(from)) / 2;
  const own = y(index + 1);
  const last = column(lane.steps[lane.steps.length - 1]!);
  const start = `M${x(from)} ${y(0)}C${x(from) + bend} ${y(0)} ${x(from + 1) - bend} ${own} ${x(from + 1)} ${own}`;
  if (lane.edited === null || end === null) return `${start}H${x(last)}`;
  return `${start}H${x(end - 1)}C${x(end - 1) + bend} ${own} ${x(end) - bend} ${y(0)} ${x(end)} ${y(0)}`;
}

/** Where a lane's name ends: just before its line bends down into the lane. A long name is cut to the room there. */
function nameEnd(lane: TimelineLane, { x }: Shape): number {
  return x(column(lane.from) + 0.5) - 4;
}

function StepShape({ step }: { step: TimelineStep }) {
  if (step.mark === "search") return <circle r={3.5} className="tl-ring" />;
  if (step.mark === "edit") return <rect x={-3.6} y={-3.6} width={7.2} height={7.2} rx={1.2} transform="rotate(45)" className="tl-fill" />;
  if (step.mark === "run") return <rect x={-3.2} y={-3.2} width={6.4} height={6.4} rx={1.6} className="tl-fill" />;
  if (step.mark === "publish") return <circle r={4.5} className="tl-fill" />;
  if (step.mark === "other") return <circle r={2.5} className="tl-fill" />;
  if (step.mark !== "test") return <circle r={3.5} className="tl-fill" />;
  return (
    <>
      <circle r={5.5} className="tl-ring" />
      {step.state === "done" ? <path d="M-2.4 .2l1.7 1.7 3.1-3.5" className="tl-stroke" /> : null}
      {step.state === "failed" ? <path d="M-2 -2l4 4M2 -2l-4 4" className="tl-stroke" /> : null}
    </>
  );
}

/** How a step's mark reads: one the turn changed something with stands out, and a run says how it went. */
function markTone(step: TimelineStep): string | undefined {
  if (step.state === "failed") return "bad";
  if (step.mark === "test" && step.state === "done") return "ok";
  return step.mark === "edit" || step.mark === "publish" ? "ink" : undefined;
}

function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    setWidth(element.clientWidth);
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

/**
 * The turn drawn in time: one line for the turn, a lane for each file it kept coming back to, a mark for each thing
 * it did. Moving along it reads each step back as its line; pressing one keeps it and opens that line.
 */
export function WorkTimeline({ entries, turn, live, renderBlocks }: { entries: WorkEntry[]; turn: Block[]; live: boolean; renderBlocks: RenderBlocks }) {
  const timeline = useMemo(() => workTimeline(entries.flatMap((entry) => (entry.kind === "phase" ? workObjects(entry.phase.blocks, turn, live) : []))), [entries, turn, live]);
  const [ref, width] = useWidth();
  const [hovered, setHovered] = useState<number | null>(null);
  const [pinned, setPinned] = useState<number | null>(null);
  const clip = useId();
  const { steps, lanes } = timeline;
  const last = steps.length - 1;
  const view = Math.min(hovered ?? pinned ?? last, last);
  const step = steps[view];
  const shape = shapeOf(timeline, width, live);
  const height = ROW * (lanes.length + 1);
  if (!step) return <div ref={ref} className="work-timeline" />;
  const at = (event: MouseEvent) => Math.max(0, Math.min(last, Math.round((event.clientX - event.currentTarget.getBoundingClientRect().left - LEFT) / (shape.x(1) - shape.x(0))) - 1));
  const onKey = (event: KeyboardEvent) => {
    const move = STEPS[event.key] ?? 0;
    if (!move) return;
    event.preventDefault();
    setPinned(Math.max(0, Math.min(last, view + move)));
  };
  return (
    <div ref={ref} className="work-timeline">
      <div
        className="tl-graph"
        style={{ height, width: shape.width }}
        tabIndex={0}
        role="slider"
        aria-label="Turn timeline"
        aria-valuemin={1}
        aria-valuemax={steps.length}
        aria-valuenow={view + 1}
        aria-valuetext={`${objectVerb(step.object)} ${step.chip?.label ?? ""}`}
        onPointerMove={(event) => setHovered(at(event))}
        onPointerLeave={() => setHovered(null)}
        onClick={(event) => setPinned((kept) => (kept === at(event) ? null : at(event)))}
        onKeyDown={onKey}
      >
        <svg width={shape.width} height={height} aria-hidden="true">
          <defs>
            <clipPath id={clip}>
              <rect x={0} y={0} height={height} className="tl-reach" style={{ width: shape.x(column(view)) + 1 }} />
            </clipPath>
          </defs>
          <Lines timeline={timeline} shape={shape} className="tl-base" />
          <g clipPath={`url(#${clip})`}>
            <Lines timeline={timeline} shape={shape} className="tl-lit" />
          </g>
          <line className="tl-head" x1={0} x2={0} y1={4} y2={height - 4} style={{ translate: `${shape.x(column(view))}px 0` }} data-on={hovered !== null || pinned !== null || undefined} />
          <circle r={2.5} className="tl-fill tl-start" cx={shape.x(0)} cy={shape.y(0)} />
          {steps.map((each, index) => (
            <g
              key={each.id}
              className="tl-mark"
              data-tone={markTone(each)}
              data-after={index > view || undefined}
              data-current={index === view || undefined}
              transform={`translate(${shape.x(column(index))} ${shape.y(each.lane)})`}
            >
              <circle r={10} className="tl-halo" />
              <StepShape step={each} />
            </g>
          ))}
          {shape.end === null ? null : <circle r={5} className="tl-fill tl-end" cx={shape.x(shape.end)} cy={shape.y(0)} />}
        </svg>
        <Names lanes={lanes} shape={shape} current={step.lane} onPick={setPinned} />
      </div>
      <div className="tl-now">
        <ol className="work-acts">
          <ActRow
            key={step.id}
            line={{ object: step.object, times: 1, group: [] }}
            open={pinned === view || (live && view === last)}
            current={live && view === last}
            onToggle={() => setPinned((kept) => (kept === view ? null : view))}
            renderBlocks={renderBlocks}
          />
        </ol>
      </div>
    </div>
  );
}

/** Each lane's name; pressing one goes to the file's last step. */
function Names({ lanes, shape, current, onPick }: { lanes: TimelineLane[]; shape: Shape; current: number; onPick: (step: number) => void }) {
  return lanes.map((lane, index) => {
    const end = nameEnd(lane, shape);
    return (
      <button
        key={lane.path}
        type="button"
        className="tl-name"
        data-tip={lane.path}
        data-on={current === index + 1 || undefined}
        style={{ left: end, top: shape.y(index + 1), maxWidth: end }}
        onClick={(event) => {
          event.stopPropagation();
          onPick(lane.steps[lane.steps.length - 1]!);
        }}
      >
        <FileGlyph path={lane.name} size={14} className="work-chip-icon" />
        <span>{lane.name}</span>
      </button>
    );
  });
}

function Lines({ timeline, shape, className }: { timeline: Timeline; shape: Shape; className: string }) {
  const { x, y, end } = shape;
  return (
    <g className={className}>
      <path d={`M${x(0)} ${y(0)}H${x(end ?? column(timeline.steps.length - 1))}`} />
      {timeline.lanes.map((lane, index) => (
        <path key={lane.path} d={lanePath(lane, index, shape)} />
      ))}
    </g>
  );
}
