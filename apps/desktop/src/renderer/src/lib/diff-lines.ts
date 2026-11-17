/**
 * Lines read in the diff's own tones rather than the highlighter's: every line in title ink, added lines on
 * --ok-soft and removed ones on --bad-soft, square runs that meet edge to edge. A file's "No newline at end of file"
 * is a note about the line above, so it carries no + or - of its own and reads in the muted ink. app.css sets the type
 * and the line numbers.
 */
export const PLAIN_LINES = `
  [data-line] span { color: inherit; }
  [data-line] { color: var(--ink); }
  :is([data-line], [data-column-number], [data-gutter-buffer])[data-line-type="change-addition"] { background-color: var(--ok-soft); }
  :is([data-line], [data-column-number], [data-gutter-buffer])[data-line-type="change-deletion"] { background-color: var(--bad-soft); }
  [data-no-newline] { color: var(--ink-3); }
  [data-indicators="classic"] [data-no-newline][data-line-type]::before { content: none; }
`;
