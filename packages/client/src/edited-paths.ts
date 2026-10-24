/** Files a tool call wrote, from the input shapes Claude Code and Codex use. Relative to the workspace when the path lies inside it. */
export function editedPaths(name: string, input: unknown, basePath?: string): string[] {
  const short = name.replace(/^mcp__[^_]+__|^openorc\./, "");
  if (!/^(edit|multiedit|write|apply_patch|write_file|str_replace|create_file|notebookedit)$/i.test(short)) return [];
  const paths: string[] = [];
  if (Array.isArray(input)) {
    for (const entry of input) if (entry && typeof entry.path === "string") paths.push(entry.path);
  } else if (input && typeof input === "object") {
    const record = input as Record<string, unknown>;
    for (const key of ["file_path", "path", "notebook_path"])
      if (typeof record[key] === "string") {
        paths.push(record[key] as string);
        break;
      }
    let patch = "";
    if (typeof record["patch"] === "string") patch = record["patch"];
    else if (typeof record["input"] === "string") patch = record["input"];
    for (const line of patch.split("\n")) {
      const match = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/.exec(line);
      if (match) paths.push(match[1]!.trim());
    }
  }
  const prefix = basePath ? `${basePath.replace(/\/+$/, "")}/` : null;
  return [...new Set(paths.map((path) => (prefix && path.startsWith(prefix) ? path.slice(prefix.length) : path)))];
}
