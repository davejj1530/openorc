import { expect, it } from "vitest";
import { PLAIN_LINES } from "./diff-lines";

it("draws a file's 'No newline at end of file' as a quiet note, with no + or - of the line above it", () => {
  // The diff library gives the note its line's sign under classic indicators; the app's sheet comes after and takes it away.
  expect(PLAIN_LINES).toContain('[data-indicators="classic"] [data-no-newline][data-line-type]::before { content: none; }');
  expect(PLAIN_LINES).toContain("[data-no-newline] { color: var(--ink-3); }");
});
