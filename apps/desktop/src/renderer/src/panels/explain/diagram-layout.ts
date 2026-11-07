import dagre, { type EdgeLabel, type GraphLabel, type NodeLabel } from "@dagrejs/dagre";
import type { CodeExplanation, DiagramEdge, DiagramNode } from "@openorc/protocol";

export type Diagram = Extract<CodeExplanation, { view: "diagram" }>;

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

/** A rectangle by its top-left corner. */
export interface Box extends Point, Size {}

export interface PlacedNode {
  node: DiagramNode;
  box: Box;
}

export interface RoutedEdge {
  /** Unique within one layout, so two edges between the same nodes stay apart. */
  id: string;
  edge: DiagramEdge;
  /** From the source's boundary to the target's, through the bends dagre routed around other nodes. */
  points: Point[];
  label: { text: string; box: Box } | null;
}

/** Every box, point and label lies within (0, 0) to `bounds`. */
export interface DiagramLayout {
  nodes: PlacedNode[];
  edges: RoutedEdge[];
  bounds: Size;
}

/** Fits a 13px label on one line and a 12px summary on two, inside 10px top and 12px bottom padding. */
export const nodeSize: Size = { width: 240, height: 76 };
const spacing = { nodesep: 28, edgesep: 14, ranksep: 48 };
const labelPill = { height: 20, padding: 8, charWidth: 6.6, maxWidth: 160 };
/** How far a self-loop reaches past its node's right side. */
const loopReach = 30;

function labelWidth(text: string): number {
  return Math.min(labelPill.maxWidth, Math.ceil(text.length * labelPill.charWidth) + labelPill.padding * 2);
}

/**
 * dagre reserves room for a self-loop beside its node but routes it as a zigzag through the node, so the loop is drawn
 * here: out of the right side and back in, with its label past the loop.
 */
function selfLoop(box: Box, text: string | null): Pick<RoutedEdge, "points" | "label"> {
  const right = box.x + box.width;
  const middle = box.y + box.height / 2;
  const points = [
    { x: right, y: middle - 16 },
    { x: right + loopReach * 0.7, y: middle - 22 },
    { x: right + loopReach, y: middle },
    { x: right + loopReach * 0.7, y: middle + 22 },
    { x: right, y: middle + 16 },
  ];
  if (text === null) return { points, label: null };
  return { points, label: { text, box: { x: right + loopReach + 6, y: middle - labelPill.height / 2, width: labelWidth(text), height: labelPill.height } } };
}

function edgeSpace(edge: DiagramEdge): Size {
  const text = edge.label === null ? 0 : labelWidth(edge.label);
  if (edge.from === edge.to) return { width: loopReach + (text && text + 6), height: text && labelPill.height };
  return { width: text, height: text && labelPill.height };
}

function runDagre(diagram: Diagram) {
  const graph = new dagre.graphlib.Graph<GraphLabel, NodeLabel, EdgeLabel>({ multigraph: true });
  graph.setGraph({ rankdir: "TB", ...spacing, marginx: 0, marginy: 0 });
  for (const node of diagram.nodes) graph.setNode(node.id, { ...nodeSize });
  diagram.edges.forEach((edge, index) => graph.setEdge({ v: edge.from, w: edge.to, name: `e${index}` }, { ...edgeSpace(edge), labelpos: "c" }));
  dagre.layout(graph);
  return graph;
}

/** Moves everything so the top-left of what is drawn sits at the origin. */
function atOrigin(nodes: PlacedNode[], edges: RoutedEdge[]): DiagramLayout {
  const xs: number[] = [];
  const ys: number[] = [];
  const add = (box: Box) => {
    xs.push(box.x, box.x + box.width);
    ys.push(box.y, box.y + box.height);
  };
  nodes.forEach(({ box }) => add(box));
  for (const edge of edges) {
    edge.points.forEach((point) => add({ ...point, width: 0, height: 0 }));
    if (edge.label) add(edge.label.box);
  }
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  const move = <T extends Point>(point: T): T => ({ ...point, x: point.x - left, y: point.y - top });
  return {
    nodes: nodes.map((placed) => ({ ...placed, box: move(placed.box) })),
    edges: edges.map((edge) => ({ ...edge, points: edge.points.map(move), label: edge.label && { ...edge.label, box: move(edge.label.box) } })),
    bounds: { width: Math.max(...xs) - left, height: Math.max(...ys) - top },
  };
}

/** Places a diagram top to bottom with fixed node boxes, so it never waits on the DOM to measure. */
export function layoutDiagram(diagram: Diagram): DiagramLayout {
  const graph = runDagre(diagram);
  const boxes = new Map<string, Box>();
  const nodes = diagram.nodes.map((node) => {
    const { x = 0, y = 0 } = graph.node(node.id);
    const box = { x: x - nodeSize.width / 2, y: y - nodeSize.height / 2, ...nodeSize };
    boxes.set(node.id, box);
    return { node, box };
  });
  const edges = diagram.edges.map((edge, index): RoutedEdge => {
    const id = `e${index}`;
    if (edge.from === edge.to) return { id, edge, ...selfLoop(boxes.get(edge.from)!, edge.label) };
    const routed = graph.edge({ v: edge.from, w: edge.to, name: id });
    const points = (routed.points ?? []).map(({ x, y }) => ({ x, y }));
    const label =
      edge.label === null
        ? null
        : { text: edge.label, box: { x: (routed.x ?? 0) - (routed.width ?? 0) / 2, y: (routed.y ?? 0) - labelPill.height / 2, width: routed.width ?? 0, height: labelPill.height } };
    return { id, edge, points, label };
  });
  return atOrigin(nodes, edges);
}

/** A smooth curve through every point (Catmull-Rom as cubic Béziers), stopping `inset` short of the last one. */
export function curveThrough(points: Point[], inset = 0): string {
  const end = trimEnd(points, inset);
  const all = [...points.slice(0, -1), end];
  let path = `M${all[0]!.x},${all[0]!.y}`;
  for (let i = 0; i < all.length - 1; i++) {
    const [p0, p1, p2, p3] = [all[i - 1] ?? all[i]!, all[i]!, all[i + 1]!, all[i + 2] ?? all[i + 1]!];
    path += ` C${p1.x + (p2.x - p0.x) / 6},${p1.y + (p2.y - p0.y) / 6} ${p2.x - (p3.x - p1.x) / 6},${p2.y - (p3.y - p1.y) / 6} ${p2.x},${p2.y}`;
  }
  return path;
}

function direction(points: Point[]): Point {
  const tip = points.at(-1)!;
  const before = points.at(-2) ?? tip;
  const length = Math.hypot(tip.x - before.x, tip.y - before.y) || 1;
  return { x: (tip.x - before.x) / length, y: (tip.y - before.y) / length };
}

function trimEnd(points: Point[], inset: number): Point {
  const tip = points.at(-1)!;
  const { x, y } = direction(points);
  return { x: tip.x - x * inset, y: tip.y - y * inset };
}

/** A filled arrowhead whose tip touches the last point, pointing along the edge's final heading. */
export function arrowhead(points: Point[], length = 8, halfWidth = 4.5): string {
  const tip = points.at(-1)!;
  const { x, y } = direction(points);
  const base = { x: tip.x - x * length, y: tip.y - y * length };
  return `M${tip.x},${tip.y} L${base.x - y * halfWidth},${base.y + x * halfWidth} L${base.x + y * halfWidth},${base.y - x * halfWidth} Z`;
}

/** Where the canvas shows the diagram: screen = world * k + (x, y). */
export interface Camera {
  x: number;
  y: number;
  k: number;
}

export const zoomRange = { min: 0.25, max: 2 } as const;

export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

const clampZoom = (k: number) => Math.min(zoomRange.max, Math.max(zoomRange.min, k));

/** Centers the whole diagram inside the viewport less its insets, never enlarging it past its own size. */
export function fitCamera(bounds: Size, viewport: Size, insets: Insets): Camera {
  const room = { width: viewport.width - insets.left - insets.right, height: viewport.height - insets.top - insets.bottom };
  if (room.width <= 0 || room.height <= 0 || bounds.width <= 0 || bounds.height <= 0) return { x: 0, y: 0, k: 1 };
  const k = clampZoom(Math.min(1, room.width / bounds.width, room.height / bounds.height));
  return { x: insets.left + (room.width - bounds.width * k) / 2, y: insets.top + (room.height - bounds.height * k) / 2, k };
}

/** Below this scale a node's label stops being readable. */
export const readableZoom = 0.8;

/** Where the flow starts: its first entry node, else its topmost node. */
export function flowStart(layout: DiagramLayout): Box | null {
  const byPlace = [...layout.nodes].sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
  return (byPlace.find((placed) => placed.node.kind === "entry") ?? byPlace[0])?.box ?? null;
}

/**
 * Where the canvas opens: the whole diagram when it fits at a readable scale, else readable and centered on where the
 * flow starts, for the reader to follow it from there.
 */
export function startCamera(layout: DiagramLayout, viewport: Size, insets: Insets): Camera {
  const fit = fitCamera(layout.bounds, viewport, insets);
  const start = flowStart(layout);
  if (fit.k >= readableZoom || viewport.width <= 0 || !start) return fit;
  const k = readableZoom;
  return { x: viewport.width / 2 - (start.x + start.width / 2) * k, y: insets.top - start.y * k, k };
}

/** Scales by `factor` around a screen point, which stays where it is. */
export function zoomAt(camera: Camera, factor: number, at: Point): Camera {
  const k = clampZoom(camera.k * factor);
  const ratio = k / camera.k;
  return { x: at.x - (at.x - camera.x) * ratio, y: at.y - (at.y - camera.y) * ratio, k };
}

const onScreen = (camera: Camera, box: Box): Box => ({ x: box.x * camera.k + camera.x, y: box.y * camera.k + camera.y, width: box.width * camera.k, height: box.height * camera.k });

/**
 * The smallest pan that brings a world box inside a screen area, with `margin` to spare. Returns the same camera when
 * the box is already inside, or when the area is too small to hold it.
 */
export function revealBox(camera: Camera, box: Box, area: Box, margin: number): Camera {
  const nudge = (start: number, size: number, areaStart: number, areaSize: number) => {
    if (size + margin * 2 > areaSize) return 0;
    if (start < areaStart + margin) return areaStart + margin - start;
    if (start + size > areaStart + areaSize - margin) return areaStart + areaSize - margin - (start + size);
    return 0;
  };
  const at = onScreen(camera, box);
  const dx = nudge(at.x, at.width, area.x, area.width);
  const dy = nudge(at.y, at.height, area.y, area.height);
  return dx === 0 && dy === 0 ? camera : { ...camera, x: camera.x + dx, y: camera.y + dy };
}

/**
 * The smallest pan that slides a world box out from under a screen obstacle, to its left or below it, while keeping
 * the box inside `area`. Returns the same camera when the box is clear already or neither way fits.
 */
export function clearOf(camera: Camera, box: Box, obstacle: Box, area: Box, margin: number): Camera {
  const at = onScreen(camera, box);
  const under = at.x < obstacle.x + obstacle.width + margin && obstacle.x - margin < at.x + at.width && at.y < obstacle.y + obstacle.height + margin && obstacle.y - margin < at.y + at.height;
  if (!under) return camera;
  const fits = ({ x, y }: Point) => at.x + x >= area.x + margin && at.y + y + at.height <= area.y + area.height - margin;
  const ways = [
    { x: obstacle.x - margin - (at.x + at.width), y: 0 },
    { x: 0, y: obstacle.y + obstacle.height + margin - at.y },
  ].filter(fits);
  const shortest = ways.sort((a, b) => Math.hypot(a.x, a.y) - Math.hypot(b.x, b.y))[0];
  return shortest ? { ...camera, x: camera.x + shortest.x, y: camera.y + shortest.y } : camera;
}
