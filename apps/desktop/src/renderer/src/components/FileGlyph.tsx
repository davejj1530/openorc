import type { ProjectStackIconId } from "../../../shared/project-stack-icons";
import { FileCode2, FileText, Folder, Image } from "./icons";
import { ProjectStackIcon } from "./ProjectStackIcon";

const languages: Record<string, ProjectStackIconId> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "react",
  jsx: "react",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  go: "go",
  rs: "rust",
  java: "java",
  cs: "csharp",
  rb: "ruby",
  php: "php",
  swift: "swift",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  hpp: "cpp",
  vue: "vue",
  svelte: "svelte",
  astro: "astro",
};

/** A file's mark: its language's logo where we ship one, otherwise what kind of file it is. */
export function FileGlyph({ path, size = 12, className }: { path: string; size?: number; className?: string }) {
  if (/[\\/]$/.test(path)) return <Folder size={size} className={className} />;
  const extension = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase() ?? "";
  const language = languages[extension];
  if (language) return <ProjectStackIcon id={language} size={size} />;
  if (/^(png|jpe?g|gif|webp|svg|avif|ico)$/.test(extension)) return <Image size={size} className={className} />;
  if (/^(md|mdx|txt|rst)$/.test(extension)) return <FileText size={size} className={className} />;
  return <FileCode2 size={size} className={className} />;
}
