import { expect, it } from "vitest";
import { chunksInView, matchLines, monoLines, monoMetrics } from "./mono-lines";

const numbered = (count: number) => Array.from({ length: count }, (_, i) => `line ${i + 1}`).join("\n");
const standard = monoMetrics(1);
/** iOS Text Size multipliers: Extra Small, the default, xxLarge, AX Large and AX XXXL. */
const textSizes = [0.823, 1, 1.235, 2.143, 3.571];
/** How tall iOS draws a Text of these lines: each `leading-5` line 20 pt at the default size, scaled with Text Size. */
const drawnHeight = (lines: string[], fontScale: number) => lines.length * 20 * fontScale;

it("shows the first 200 lines of a long output in native views of at most 50 lines", () => {
  const { chunks, total } = monoLines(numbered(2000), false, standard);
  expect(total).toBe(2000);
  expect(chunks.map((chunk) => chunk.length)).toEqual([50, 50, 50, 50]);
  expect(chunks.flat().at(-1)).toBe("line 200");
});

it("shows every line in views of at most 50 lines once asked", () => {
  const { chunks } = monoLines(numbered(2000), true, standard);
  expect(chunks.flat()).toHaveLength(2000);
  expect(Math.max(...chunks.map((chunk) => chunk.length))).toBe(50);
});

it("cuts a line too wide to draw, and counts the columns of the widest line it keeps", () => {
  const { chunks, total, columns } = monoLines(`short\n${"x".repeat(1_000_000)}`, true, standard);
  expect(total).toBe(2);
  expect(chunks[0]![1]!.length).toBeLessThan(1000);
  expect(chunks[0]![1]!.endsWith("…")).toBe(true);
  expect(columns).toBe(chunks[0]![1]!.length);
});

it("keeps a short output whole", () => {
  expect(monoLines("total 0\ndone", false, standard)).toEqual({ chunks: [["total 0", "done"]], total: 2, columns: 7 });
});

it("keeps every drawn Text within the size one bitmap can hold, at every text size", () => {
  const wide = Array.from({ length: 300 }, () => "x".repeat(1000)).join("\n");
  for (const fontScale of textSizes) {
    const metrics = monoMetrics(fontScale);
    for (const lines of monoLines(wide, true, metrics).chunks) {
      expect(drawnHeight(lines, fontScale)).toBeLessThanOrEqual(1000);
      expect(Math.max(...lines.map((line) => line.length)) * 7.2 * fontScale).toBeLessThanOrEqual(2880);
    }
  }
});

it("draws every line the reader scrolls to, at every text size", () => {
  for (const fontScale of textSizes) {
    const metrics = monoMetrics(fontScale);
    const { chunks } = monoLines(numbered(2000), true, metrics);
    const heights = chunks.map((lines) => drawnHeight(lines, fontScale));
    const tops = heights.map((_, index) => heights.slice(0, index).reduce((sum, height) => sum + height, 0));
    const end = tops.at(-1)! + heights.at(-1)!;
    const screen = 600;
    for (let top = 0; top < end; top += 97) {
      const [first, last] = chunksInView({ top, height: screen }, 0, chunks.length, metrics.chunkHeight);
      const onScreen = tops.flatMap((chunkTop, index) => (chunkTop < top + screen && chunkTop + heights[index]! > top ? [index] : []));
      expect(onScreen.filter((index) => index < first || index > last)).toEqual([]);
    }
  }
});

it("draws each line of output as one line: iOS breaks a line at a carriage return, a terminal draws over it", () => {
  const { chunks } = monoLines("one\r\ntwo\r\n10%\r55%\r100%\nkept\u2028together\vhere\fand\u0085there\u2029too\r", true, standard);
  expect(chunks.flat()).toEqual(["one", "two", "100%", "kept together here and there too"]);
});

it("spaces a tab-separated line as a terminal does, so it draws as one line and its width is counted", () => {
  // `gh pr list` prints tabs when its output is not a terminal; iOS would wrap each of these lines past its last tab stop.
  const listed = "4182\tfix(mobile): keep the thread screen still while a reply streams\tdavid/thread-screen\tOPEN\t2026-10-24T01:02:03Z";
  const { chunks, columns } = monoLines(`${listed}\n\t\t\t\t\t\t\t\t\t\t\t\t\tindented\nab\tc`, true, standard);
  expect(chunks.flat().some((line) => line.includes("\t"))).toBe(false);
  expect(chunks[0]![0]).toBe("4182    fix(mobile): keep the thread screen still while a reply streams david/thread-screen     OPEN    2026-10-24T01:02:03Z");
  expect(chunks[0]![1]).toBe(`${" ".repeat(104)}indented`);
  expect(chunks[0]![2]).toBe("ab      c");
  expect(columns).toBe(chunks[0]![0]!.length);
  for (const fontScale of textSizes) expect(monoLines(listed, true, monoMetrics(fontScale)).chunks[0]![0]!.includes("\t")).toBe(false);
});

it("draws only the chunks near the screen, however long the output", () => {
  // 11,000 lines in 50-line chunks of 1000 pt, starting 300 pt down the sheet, with an 800 pt screen.
  const chunks = 220;
  expect(chunksInView({ top: 0, height: 800 }, 300, chunks, 1000)).toEqual([0, 0]);
  const [first, last] = chunksInView({ top: 100_000, height: 800 }, 300, chunks, 1000);
  expect(first).toBe(99);
  expect(last).toBe(100);
  expect(chunksInView({ top: 1e9, height: 800 }, 300, chunks, 1000)).toEqual([219, 219]);
});

it("draws nothing while the lines are far below the screen", () => {
  expect(chunksInView({ top: 0, height: 800 }, 5000, 10, 1000)).toEqual([0, -1]);
});

it("draws the first chunks until it knows where the lines sit", () => {
  expect(chunksInView({ top: 5000, height: 800 }, null, 4, 1000)).toEqual([0, 1]);
});

it("reads a search as one block: each file's path, then its lines by number, with one line budget for all files", () => {
  const groups = Array.from({ length: 1500 }, (_, i) => ({
    path: `src/file-${i}.ts`,
    lines: [
      { line: 3, text: "useSomething()" },
      { line: null, text: "context", context: true },
    ],
  }));
  const { text, paths } = matchLines(groups);
  const lines = text.split("\n");
  expect(lines.slice(0, 5)).toEqual(["src/file-0.ts", "3  useSomething()", "context", "", "src/file-1.ts"]);
  expect([...paths].slice(0, 2)).toEqual([0, 4]);
  expect(paths.size).toBe(1500);
  expect(monoLines(text, false, standard).chunks.flat()).toHaveLength(200);
});
