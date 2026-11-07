import { expect, it } from "vitest";
import { noteSegments } from "./note-segments";

const lines = ["// cart", "", "export function total(items) {", "  let sum = 0;", "  for (const item of items) {", "    sum += item;", "  }", "  return sum;", "}", "", ""];
const note = (start: number, end = start) => ({ lines: { start, end }, text: `Line ${start}.` });

it("shows code before the first note on its own, and gives each note its own lines and the brackets that close them", () => {
  expect(noteSegments([note(3), note(4), note(5, 6), note(8)], { start: 1, end: 11 }, lines)).toEqual([
    { start: 1, end: 1, note: null },
    { start: 3, end: 3, note: note(3) },
    { start: 4, end: 4, note: note(4) },
    { start: 5, end: 7, note: note(5, 6) },
    { start: 8, end: 9, note: note(8) },
  ]);
});

it("keeps to the stretch asked for, and shows code no note covers on its own instead of under the note above", () => {
  expect(noteSegments([note(1), note(4), note(8)], { start: 3, end: 7 }, lines)).toEqual([
    { start: 3, end: 3, note: null },
    { start: 4, end: 4, note: note(4) },
    { start: 5, end: 7, note: null },
  ]);
  expect(noteSegments([], { start: 2, end: 11 }, lines)).toEqual([{ start: 3, end: 9, note: null }]);
});

it("gives a note the closing tags after it", () => {
  const jsx = ["return (", "  <Tooltip>", "    <Button />", "  </Tooltip>", ");", "const after = 1;"];
  expect(noteSegments([note(2, 3), note(6)], { start: 1, end: 6 }, jsx)).toEqual([
    { start: 1, end: 1, note: null },
    { start: 2, end: 5, note: note(2, 3) },
    { start: 6, end: 6, note: note(6) },
  ]);
});
