/** A file Codex cites in a reply with its `:codex-file-citation{path="…" purpose="…"}` directive. */
export interface FileCitation {
  path: string;
  line?: number;
  endLine?: number;
}

const DIRECTIVE = /:codex-file-citation\{([^}\n]*)\}/g;
const ATTRIBUTE = /([A-Za-z_][\w-]*)="((?:[^"\\]|\\.)*)"/g;

function citation(attributes: string): FileCitation | null {
  const values = new Map([...attributes.matchAll(ATTRIBUTE)].map(([, name, value = ""]) => [name, value.replace(/\\(.)/g, "$1")]));
  const path = values.get("path");
  if (!path) return null;
  const line = Number(values.get("line_start") ?? values.get("line"));
  const endLine = Number(values.get("line_end"));
  return { path, ...(line > 0 ? { line } : {}), ...(endLine > line ? { endLine } : {}) };
}

/** Rewrites each citation directive with `render`; a directive without a path is dropped. */
export function replaceFileCitations(text: string, render: (citation: FileCitation) => string): string {
  if (!text.includes(":codex-file-citation{")) return text;
  return text.replace(DIRECTIVE, (_match, attributes: string) => {
    const found = citation(attributes);
    return found ? render(found) : "";
  });
}

export function citationName(citation: FileCitation): string {
  return citation.path.split(/[\\/]/).filter(Boolean).pop() ?? citation.path;
}
