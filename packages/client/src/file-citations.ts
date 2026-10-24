import { citationName, replaceFileCitations, type FileCitation } from "@openorc/protocol";

/** Codex's citation directive as the Markdown link the transcript opens: the file's name, linked to its path and lines. */
function citationLink(citation: FileCitation): string {
  const name = citationName(citation);
  if (/[<>\n]/.test(citation.path)) return `\`${name}\``;
  const location = citation.line ? `#L${citation.line}${citation.endLine ? `-L${citation.endLine}` : ""}` : "";
  return `[${name.replace(/[[\]\\]/g, "\\$&")}](<${citation.path}${location}>)`;
}

/** A reply with each `:codex-file-citation{…}` directive written as a Markdown link. */
export function citationLinks(text: string): string {
  return replaceFileCitations(text, citationLink);
}
