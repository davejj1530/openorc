import { describe, expect, it } from "vitest";
import type { DiagramEdge, DiagramNode, DiagramNodeKind } from "@openorc/protocol";
import {
  arrowhead,
  clearOf,
  curveThrough,
  fitCamera,
  layoutDiagram,
  nodeSize,
  revealBox,
  zoomAt,
  zoomRange,
  type Box,
  type Diagram,
  type DiagramLayout,
  type Point,
  readableZoom,
  startCamera,
} from "./diagram-layout";

const node = (id: string, kind: DiagramNodeKind = "step"): DiagramNode => ({ id, label: `Node ${id}`, kind, summary: `What ${id} does.`, detail: `About ${id}.`, lines: null });
const edge = (from: string, to: string, label: string | null = null): DiagramEdge => ({ from, to, label });
const diagram = (nodes: DiagramNode[], edges: DiagramEdge[]): Diagram => ({ view: "diagram", summary: "A file.", nodes, edges });

const branching = diagram(
  [node("start", "entry"), node("read", "external"), node("valid", "decision"), node("cache", "data"), node("save"), node("fail", "output"), node("done", "output")],
  [edge("start", "read"), edge("read", "valid"), edge("valid", "save", "yes"), edge("valid", "fail", "no"), edge("save", "cache"), edge("cache", "done"), edge("save", "read", "retry")],
);
const looping = diagram([node("a"), node("b"), node("c"), node("alone", "data")], [edge("a", "b"), edge("b", "c"), edge("c", "a", "again"), edge("c", "c", "for each line"), edge("a", "b", "also")]);
const siblingLoops = diagram([node("root", "entry"), node("x"), node("y")], [edge("root", "x"), edge("root", "y"), edge("x", "x", "for each file"), edge("y", "y", "until done")]);

const overlaps = (a: Box, b: Box) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
const onEdgeOf = (point: Point, box: Box) => {
  const inside = point.x >= box.x - 1 && point.x <= box.x + box.width + 1 && point.y >= box.y - 1 && point.y <= box.y + box.height + 1;
  const nearSide = Math.min(Math.abs(point.x - box.x), Math.abs(point.x - box.x - box.width), Math.abs(point.y - box.y), Math.abs(point.y - box.y - box.height)) <= 1;
  return inside && nearSide;
};
const boxOf = (layout: DiagramLayout, id: string) => layout.nodes.find((placed) => placed.node.id === id)!.box;

describe.each([
  ["a branching flow", branching],
  ["a cycle, a self-loop, a repeated edge and a disconnected node", looping],
  ["two neighbours that each loop", siblingLoops],
])("laying out %s", (_name, input) => {
  const layout = layoutDiagram(input);

  it("gives every node its own fixed-size box", () => {
    expect(layout.nodes.map((placed) => placed.node)).toEqual(input.nodes);
    for (const { box } of layout.nodes) {
      expect([box.width, box.height]).toEqual([nodeSize.width, nodeSize.height]);
      expect([box.x, box.y].every(Number.isFinite)).toBe(true);
    }
  });

  it("keeps every pair of boxes apart", () => {
    const boxes = layout.nodes.map((placed) => placed.box);
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) expect(overlaps(boxes[i]!, boxes[j]!), `${i} and ${j}`).toBe(false);
  });

  it("routes each edge from its source's boundary to its target's", () => {
    expect(layout.edges.map((routed) => routed.edge)).toEqual(input.edges);
    expect(new Set(layout.edges.map((routed) => routed.id)).size).toBe(input.edges.length);
    for (const {
      edge: { from, to },
      points,
    } of layout.edges) {
      expect(points.length).toBeGreaterThanOrEqual(2);
      expect(onEdgeOf(points[0]!, boxOf(layout, from)), `${from} to ${to} starts on ${from}`).toBe(true);
      expect(onEdgeOf(points.at(-1)!, boxOf(layout, to)), `${from} to ${to} ends on ${to}`).toBe(true);
    }
  });

  it("gives a label box to each labelled edge, clear of every node", () => {
    for (const { edge, label } of layout.edges) {
      expect(label?.text ?? null).toBe(edge.label);
      if (label) expect([label.box.width > 0, label.box.height]).toEqual([true, 20]);
      if (label) for (const { box } of layout.nodes) expect(overlaps(label.box, box), `"${label.text}" over a node`).toBe(false);
    }
  });

  it("draws everything inside bounds that start at the origin", () => {
    const boxes = [
      ...layout.nodes.map((placed) => placed.box),
      ...layout.edges.flatMap((routed) => [...routed.points.map((point) => ({ ...point, width: 0, height: 0 })), ...(routed.label ? [routed.label.box] : [])]),
    ];
    for (const box of boxes) {
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(layout.bounds.width + 1e-6);
      expect(box.y + box.height).toBeLessThanOrEqual(layout.bounds.height + 1e-6);
    }
    expect(Math.min(...boxes.map((box) => box.x))).toBeCloseTo(0);
    expect(Math.min(...boxes.map((box) => box.y))).toBeCloseTo(0);
  });
});

it("ranks a chain top to bottom", () => {
  const layout = layoutDiagram(diagram([node("a"), node("b"), node("c")], [edge("a", "b"), edge("b", "c")]));
  const [a, b, c] = ["a", "b", "c"].map((id) => boxOf(layout, id));
  expect(b!.y).toBeGreaterThanOrEqual(a!.y + a!.height);
  expect(c!.y).toBeGreaterThanOrEqual(b!.y + b!.height);
});

it("lays out a single node with no edges", () => {
  const layout = layoutDiagram(diagram([node("only", "entry")], []));
  expect(layout.nodes[0]!.box).toEqual({ x: 0, y: 0, ...nodeSize });
  expect(layout.bounds).toEqual(nodeSize);
});

it("stops the curve short of the arrowhead, whose tip is the edge's last point", () => {
  const points = [
    { x: 0, y: 0 },
    { x: 10, y: 40 },
    { x: 10, y: 100 },
  ];
  expect(curveThrough(points, 8).startsWith("M0,0 ")).toBe(true);
  expect(curveThrough(points, 8).endsWith(" 10,92")).toBe(true);
  expect(arrowhead(points).startsWith("M10,100 ")).toBe(true);
});

describe("the camera", () => {
  const viewport = { width: 600, height: 400 };
  const insets = { top: 20, right: 20, bottom: 60, left: 20 };

  it("fits a large diagram inside the viewport less its insets, centered", () => {
    const bounds = { width: 1120, height: 640 };
    const { x, y, k } = fitCamera(bounds, viewport, insets);
    expect(k).toBeCloseTo(0.5);
    expect(x).toBeCloseTo(20);
    expect([y, y + bounds.height * k]).toEqual([expect.closeTo(20), expect.closeTo(340)]);
  });

  it("fits a small diagram at its own size rather than enlarging it", () => {
    const { x, k } = fitCamera({ width: 240, height: 76 }, viewport, insets);
    expect(k).toBe(1);
    expect(x).toBeCloseTo(180);
  });

  it("never fits below the smallest zoom", () => {
    expect(fitCamera({ width: 100_000, height: 100_000 }, viewport, insets).k).toBe(zoomRange.min);
  });

  it("keeps the point under the pointer still while zooming, and clamps the zoom", () => {
    const camera = { x: 30, y: -12, k: 0.8 };
    const at = { x: 250, y: 140 };
    const world = { x: (at.x - camera.x) / camera.k, y: (at.y - camera.y) / camera.k };
    const zoomed = zoomAt(camera, 1.5, at);
    expect(zoomed.k).toBeCloseTo(1.2);
    expect(world.x * zoomed.k + zoomed.x).toBeCloseTo(at.x);
    expect(world.y * zoomed.k + zoomed.y).toBeCloseTo(at.y);
    expect(zoomAt(camera, 100, at).k).toBe(zoomRange.max);
    expect(zoomAt(camera, 0.001, at).k).toBe(zoomRange.min);
  });

  it("pans just enough to bring a box into an area, and not at all when it is already there", () => {
    const camera = { x: 0, y: 0, k: 1 };
    const area = { x: 0, y: 0, width: 400, height: 400 };
    const moved = revealBox(camera, { x: 500, y: 100, width: 240, height: 76 }, area, 16);
    expect(moved).toEqual({ x: 400 - 16 - 740, y: 0, k: 1 });
    expect(revealBox(camera, { x: 40, y: 40, width: 240, height: 76 }, area, 16)).toBe(camera);
  });

  it("slides a box out from under an obstacle the shorter way, only when it is under it and there is room", () => {
    const camera = { x: 0, y: 0, k: 1 };
    const area = { x: 0, y: 0, width: 600, height: 400 };
    const obstacle = { x: 300, y: 10, width: 290, height: 120 };
    const node = (x: number, y: number) => ({ x, y, width: 240, height: 76 });
    expect(clearOf(camera, node(400, 40), obstacle, area, 16)).toEqual({ x: 0, y: 130 + 16 - 40, k: 1 });
    expect(clearOf(camera, node(100, 40), obstacle, area, 16)).toEqual({ x: 300 - 16 - 340, y: 0, k: 1 });
    expect(clearOf(camera, node(20, 200), obstacle, area, 16)).toBe(camera);
    expect(clearOf(camera, node(400, 40), { ...obstacle, height: 380 }, area, 16)).toEqual({ x: 300 - 16 - 640, y: 0, k: 1 });
    expect(clearOf(camera, node(400, 40), { x: 10, y: 10, width: 580, height: 380 }, area, 16)).toBe(camera);
  });
});

describe("where the canvas opens", () => {
  const insets = { top: 24, right: 24, bottom: 56, left: 24 };
  const wide: Diagram = {
    view: "diagram",
    summary: "",
    nodes: [node("hub", "step"), ...["a", "b", "c", "d", "e", "f"].map((id) => node(id, "step")), node("start", "entry")],
    edges: [...["a", "b", "c", "d", "e", "f"].flatMap((id) => [edge("start", id), edge(id, "hub")])],
  };
  it("shows the whole diagram when it fits at a readable scale", () => {
    const small = layoutDiagram({ view: "diagram", summary: "", nodes: [node("start", "entry"), node("end", "output")], edges: [edge("start", "end")] });
    expect(startCamera(small, { width: 600, height: 500 }, insets)).toEqual(fitCamera(small.bounds, { width: 600, height: 500 }, insets));
  });
  it("opens a diagram that only fits smaller at a readable scale, centered on where its flow starts", () => {
    const layout = layoutDiagram(wide);
    const viewport = { width: 548, height: 600 };
    expect(fitCamera(layout.bounds, viewport, insets).k).toBeLessThan(readableZoom);
    const camera = startCamera(layout, viewport, insets);
    const start = layout.nodes.find((placed) => placed.node.id === "start")!.box;
    expect(camera.k).toBe(readableZoom);
    expect((start.x + start.width / 2) * camera.k + camera.x).toBeCloseTo(viewport.width / 2);
    expect(start.y * camera.k + camera.y).toBeCloseTo(insets.top);
  });
});
