type Point = readonly [number, number];

const edge = 78;
const halfWidth = (edge * Math.sqrt(3)) / 2;
const pointKey = ([x, y]: Point) => `${Math.round(x)},${Math.round(y)}`;
export const points = (vertices: readonly Point[]) => vertices.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(" ");
const center = (column: number, row: number): Point => [462 + column * 2 * halfWidth + (row & 1 ? halfWidth : 0), 150 + row * 1.5 * edge];

// The mark's six outer vertices and three inner edges form a tiled, top-down cube.
function corners([x, y]: Point): [Point, Point, Point, Point, Point, Point] {
  return [
    [x, y - edge],
    [x + halfWidth, y - edge / 2],
    [x + halfWidth, y + edge / 2],
    [x, y + edge],
    [x - halfWidth, y + edge / 2],
    [x - halfWidth, y - edge / 2],
  ];
}

const scale = (point: Point, origin: Point, amount: number): Point => [origin[0] + (point[0] - origin[0]) * amount, origin[1] + (point[1] - origin[1]) * amount];

function cube(column: number, row: number, agent: "claude" | "codex" | "opencode") {
  const origin = center(column, row);
  const vertices = corners(origin);
  const rounding = edge * 0.11;
  const inset = (edge - rounding / 2 - 3) / edge;
  const [top, rightTop, rightBottom, bottom, leftBottom, leftTop] = vertices.map((point) => scale(point, origin, inset));
  const faceCenter: Point = [origin[0], origin[1] - (edge * inset) / 2];
  const face = [top, rightTop, origin, leftTop].map((point) => scale(point, faceCenter, 0.76));
  const [t, , c, l] = face;
  const expand = (list: Point[]) => points(list.map((point) => (point === origin ? origin : scale(point, origin, 1.12))));
  return {
    agent,
    origin,
    vertices,
    rounding,
    face: points(face),
    body: points([top, rightTop, rightBottom, bottom, leftBottom, leftTop]),
    left: expand([leftTop, origin, bottom, leftBottom]),
    right: expand([origin, rightTop, rightBottom, bottom]),
    top: expand([top, rightTop, origin, leftTop]),
    rim: points([leftTop, origin, rightTop]),
    logoTransform: `matrix(${[t[0] - l[0], t[1] - l[1], c[0] - l[0], c[1] - l[1], l[0], l[1]].map((value) => value.toFixed(3)).join(" ")})`,
  };
}

export type LatticeCube = ReturnType<typeof cube>;

export function heroLattice() {
  const claude = cube(2, 1, "claude");
  const codex = cube(5, 3, "codex");
  const opencode = cube(3, 5, "opencode");
  const cubes = [claude, codex, opencode];
  const solid = new Set(cubes.map(({ origin }) => pointKey(origin)));
  const edges = new Map<string, [Point, Point]>();
  const graph = new Map<string, { point: Point; neighbors: string[] }>();

  const link = (from: Point, to: Point, inner = false) => {
    const id = [pointKey(from), pointKey(to)].sort().join("|");
    if (edges.has(id)) return;
    edges.set(id, [from, to]);
    if (inner) return;
    for (const [point, neighbor] of [
      [from, to],
      [to, from],
    ]) {
      const key = pointKey(point);
      const node = graph.get(key) ?? { point, neighbors: [] };
      node.neighbors.push(pointKey(neighbor));
      graph.set(key, node);
    }
  };
  for (let row = -1; row < 10; row++) {
    for (let column = -5; column < 13; column++) {
      const origin = center(column, row);
      const vertices = corners(origin);
      vertices.forEach((point, index) => link(point, vertices[(index + 1) % 6]));
      if (!solid.has(pointKey(origin))) {
        for (const index of [1, 3, 5]) link(origin, vertices[index], true);
      }
    }
  }

  // Only outer edges enter the graph, so the connection cannot cut across a cube's face.
  const route = (from: Point, to: Point) => {
    const start = pointKey(from);
    const end = pointKey(to);
    const previous = new Map<string, string | null>([[start, null]]);
    const queue = [start];
    for (const key of queue) {
      if (key === end) break;
      for (const neighbor of graph.get(key)?.neighbors ?? []) {
        if (previous.has(neighbor)) continue;
        previous.set(neighbor, key);
        queue.push(neighbor);
      }
    }
    const path: Point[] = [];
    for (let key: string | null | undefined = end; key; key = previous.get(key)) {
      const node = graph.get(key);
      if (node) path.push(node.point);
    }
    return points(path);
  };
  const waking = center(6, 2);
  const [top, right, , , , left] = corners(waking);
  return {
    cubes,
    path: [...edges.values()].map(([from, to]) => `M${points([from])}L${points([to])}`).join(""),
    routes: [route(claude.vertices[2], codex.vertices[5]), route(codex.vertices[4], opencode.vertices[1])],
    waking: { body: points(corners(waking)), face: points([top, right, waking, left]) },
  };
}
