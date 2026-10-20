import { fileExtension, fileMedia } from "@openorc/protocol";
import type { ProjectStackIconId } from "../../../shared/project-stack-icons";
import { FileCode2, FilePlain, FileText, Folder, Image } from "./icons";
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

/** What kind of file a path names, in outline: an image, other media the panel plays, prose, or code. */
export function fileIcon(path: string): typeof FileCode2 {
  const media = fileMedia(path)?.media;
  if (media === "image") return Image;
  if (media) return FilePlain;
  if (/^(md|mdx|txt|rst)$/.test(fileExtension(path))) return FileText;
  return FileCode2;
}

/** A file's mark: its language's logo where we ship one, otherwise what kind of file it is. */
export function FileGlyph({ path, size = 12, className }: { path: string; size?: number; className?: string }) {
  if (/[\\/]$/.test(path)) return <Folder size={size} className={className} />;
  const language = languages[fileExtension(path)];
  if (language) return <ProjectStackIcon id={language} size={size} />;
  const Icon = fileIcon(path);
  return <Icon size={size} className={className} />;
}
