import { useState } from "react";
import { PreviewCard } from "@base-ui/react/preview-card";
import { languageFor, type ReadObject, type WorkChip } from "@openorc/client";
import type { FileEntry, FileRead, FileScope, FolderPath } from "@openorc/protocol";
import { fileReference } from "../../../shared/file-reference";
import { cn } from "../lib/cn";
import { useRpc } from "../lib/client";
import { relativeFilePath } from "../lib/file-explorer";
import { CoversPreview } from "../lib/browser-preview";
import { floatingGround } from "../lib/use-anchor-ground";
import { FileGlyph } from "./FileGlyph";
import { ChevronRight, Folder } from "./icons";
import { ThreadLink, useThreadMedia } from "./ThreadImages";
import { Code } from "./ToolPrinted";
import { OpenedCall, type RenderBlocks } from "./WorkMarks";

const ROWS = 6;

/** Where a file row opens: its file, at the lines the read printed, which the editor selects. */
export function fileHref(chip: WorkChip): string {
  const path = chip.path ?? "";
  const lines = chip.lines;
  if (!lines) return path;
  return `${path}#L${lines.line}${lines.endLine && lines.endLine !== lines.line ? `-L${lines.endLine}` : ""}`;
}

const failed = (chip: WorkChip) => chip.blocks.some((block) => block.kind === "tool" && (block.isError || block.status === "error"));

/**
 * Files read and folders listed; past six, the rest wait behind a count. A file opens where it was read, and holding
 * the pointer on it shows the lines the agent saw. A folder grows into what it listed.
 */
export function ReadView({ read, renderBlocks }: { read: ReadObject; renderBlocks: RenderBlocks }) {
  const [all, setAll] = useState(false);
  const shown = all ? read.rows : read.rows.slice(0, ROWS);
  return (
    <div className="work-chips">
      {shown.map((row) => (row.kind === "folder" ? <FolderRow key={row.key} chip={row} renderBlocks={renderBlocks} /> : <FileRow key={row.key} chip={row} />))}
      {read.rows.length > shown.length ? (
        <button type="button" className="work-more" onClick={() => setAll(true)}>
          {read.rows.length - shown.length} more
        </button>
      ) : null}
    </div>
  );
}

function FileRow({ chip }: { chip: WorkChip }) {
  const { fileScope } = useThreadMedia();
  const content = (
    <>
      <FileGlyph path={chip.label} size={14} className="work-chip-icon" />
      <span className="work-chip-label">{chip.label}</span>
      <span className="work-chip-detail" aria-hidden={chip.path ? true : undefined}>
        {chip.detail}
      </span>
      {chip.note ? <span className="work-chip-note">{chip.note}</span> : null}
      {failed(chip) ? (
        <span className="work-chip-note" data-tone="bad">
          Failed
        </span>
      ) : null}
    </>
  );
  const href = fileHref(chip);
  const link = chip.path ? <ThreadLink href={href}>{content}</ThreadLink> : content;
  if (!chip.path || !fileScope || failed(chip))
    return (
      <span className="work-chip" data-kind={chip.kind} title={chip.title}>
        {link}
      </span>
    );
  return (
    <PreviewCard.Root>
      <PreviewCard.Trigger delay={350} closeDelay={150} render={<span className="work-chip" data-kind={chip.kind} />}>
        {link}
      </PreviewCard.Trigger>
      <PreviewCard.Portal>
        <CoversPreview />
        <PreviewCard.Positioner side="bottom" align="start" sideOffset={6} collisionPadding={12}>
          <PreviewCard.Popup ref={floatingGround} className="floating-popover read-peek">
            <ReadPeek chip={chip} href={href} scope={fileScope} />
          </PreviewCard.Popup>
        </PreviewCard.Positioner>
      </PreviewCard.Portal>
    </PreviewCard.Root>
  );
}

/** Lines a peek shows at most; the rest is one press away. */
const PEEK_LINES = 60;

/**
 * The file at the lines the agent read, highlighted and numbered, read as the file panel reads it, so pressing the
 * row right after opens at once.
 */
function ReadPeek({ chip, href, scope }: { chip: WorkChip; href: string; scope: FileScope }) {
  const { basePath } = useThreadMedia();
  const path = fileReference(href, basePath)?.path ?? "";
  const read = useRpc("files.read", { scope, path }, { enabled: path !== "" });
  return (
    <>
      <div className="read-peek-head" title={chip.path}>
        <FileGlyph path={chip.label} size={14} className="work-chip-icon" />
        <span className="read-peek-name">{chip.label}</span>
        <span className="read-peek-folder">{chip.detail}</span>
        {chip.note ? <span className="read-peek-note">{chip.note}</span> : null}
      </div>
      <div className="read-peek-body tool-view">
        <PeekLines file={read.data} failed={read.isError} lines={chip.lines} path={path} />
      </div>
    </>
  );
}

function PeekLines({ file, failed, lines, path }: { file: FileRead | undefined; failed: boolean; lines: WorkChip["lines"]; path: string }) {
  if (failed || file?.kind === "unreadable") return <span className="read-peek-quiet">This file can't be shown here</span>;
  if (file?.kind === "missing") return <span className="read-peek-quiet">This file is no longer there</span>;
  if (file?.kind === "binary") return <span className="read-peek-quiet">A binary file</span>;
  if (file?.kind !== "file") return <span className="read-peek-quiet">Loading…</span>;
  const start = lines?.line ?? 1;
  const end = Math.min(lines?.endLine ?? Infinity, start + PEEK_LINES - 1);
  const code = file.text
    .split("\n")
    .slice(start - 1, end)
    .join("\n");
  return <Code code={code} language={languageFor(path)} startLine={start} />;
}

/** A listed folder's place inside the conversation's folder: "" for its top, null when it lies outside. */
function folderInside(path: string, basePath: string | undefined): string | null {
  const relative = basePath ? relativeFilePath(path, basePath) : path;
  const inside = relative === "." ? "" : relative.replace(/^\.\//, "").replace(/\/+$/, "");
  return inside.split("/").some((part) => part === ".." || part === ".") || /^[/~\\]/.test(inside) ? null : inside;
}

/**
 * A folder it listed. Pressing it grows the folder out of the row as it is on disk, as the file panel reads it: each
 * file opens there, each folder inside opens in place. A folder outside the conversation's grows the call instead.
 */
function FolderRow({ chip, renderBlocks }: { chip: WorkChip; renderBlocks: RenderBlocks }) {
  const [open, setOpen] = useState(false);
  const { basePath, fileScope } = useThreadMedia();
  const folder = chip.path === undefined ? null : folderInside(chip.path, basePath);
  const row = (
    <button type="button" className="work-chip" data-kind={chip.kind} title={chip.title} aria-pressed={open} aria-expanded={open} onClick={() => setOpen((value) => !value)}>
      <Folder size={14} className="work-chip-icon" />
      <span className="work-chip-label">{chip.label}</span>
      <span className="work-chip-detail">{chip.detail}</span>
      {chip.note ? <span className="work-chip-note">{chip.note}</span> : null}
    </button>
  );
  if (folder === null || !fileScope)
    return (
      <OpenedCall open={open} calls={chip.blocks} renderBlocks={renderBlocks}>
        {row}
      </OpenedCall>
    );
  return (
    <div className="work-call" data-open={open || undefined}>
      {row}
      {open ? (
        <div className="work-call-body">
          <div className="work-call-details">
            <FolderTree scope={fileScope} path={folder} />
          </div>
        </div>
      ) : null}
    </div>
  );
}

const ENTRIES = 30;

/** A folder's entries, folders first as the panel lists them; ignored ones step back. */
function FolderTree({ scope, path }: { scope: FileScope; path: string }) {
  const listing = useRpc("files.list", { scope, path: path as FolderPath | "" });
  const [all, setAll] = useState(false);
  if (listing.isError) return <span className="read-peek-quiet">This folder can't be shown here</span>;
  if (!listing.data) return <span className="read-peek-quiet">Loading…</span>;
  const entries = listing.data.entries;
  const shown = all ? entries : entries.slice(0, ENTRIES);
  return (
    <ul className="work-tree">
      {shown.map((entry) => (
        <TreeEntry key={entry.path} entry={entry} scope={scope} />
      ))}
      {entries.length > shown.length ? (
        <li>
          <button type="button" className="work-more" onClick={() => setAll(true)}>
            {entries.length - shown.length} more
          </button>
        </li>
      ) : null}
      {!entries.length ? <li className="read-peek-quiet">Empty</li> : null}
    </ul>
  );
}

function TreeEntry({ entry, scope }: { entry: FileEntry; scope: FileScope }) {
  const [open, setOpen] = useState(false);
  if (entry.kind === "file")
    return (
      <li className="work-tree-entry" data-ignored={entry.ignored || undefined}>
        <ThreadLink href={entry.path}>
          <FileGlyph path={entry.name} size={14} className="work-chip-icon" />
          <span className="work-chip-label">{entry.name}</span>
        </ThreadLink>
      </li>
    );
  return (
    <li className="work-tree-entry" data-ignored={entry.ignored || undefined}>
      <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <ChevronRight size={12} className={cn("work-chevron", open && "rotate-90")} />
        <Folder size={14} className="work-chip-icon" />
        <span className="work-chip-label">{entry.name}</span>
      </button>
      {open ? <FolderTree scope={scope} path={entry.path} /> : null}
    </li>
  );
}
