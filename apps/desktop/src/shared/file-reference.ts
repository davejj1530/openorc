import { localPath } from "./image-paths";

export interface FileReference {
  path: string;
  line?: number;
  endLine?: number;
}

/** Parse citation locations before decoding, so encoded colons/hashes stay in filenames. */
export function fileReference(href: string, basePath?: string): FileReference | null {
  const location = /(?:#L(\d+)(?:-L?(\d+))?|:(\d+)(?::\d+)?)$/.exec(href);
  const target = location ? href.slice(0, location.index) : href;
  const resolved = localPath(target, basePath ?? ".");
  if (!resolved) return null;
  const path = basePath === undefined && resolved.startsWith("./") ? resolved.slice(2) : resolved;
  const line = Number(location?.[1] ?? location?.[3]);
  const endLine = Number(location?.[2]);
  return {
    path,
    ...(Number.isSafeInteger(line) && line > 0 ? { line } : {}),
    ...(Number.isSafeInteger(endLine) && endLine >= line ? { endLine } : {}),
  };
}
