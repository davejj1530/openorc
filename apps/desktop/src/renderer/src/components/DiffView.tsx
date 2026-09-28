import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { PatchDiff, Virtualizer, WorkerPoolContextProvider, type FileDiffOptions, type SelectedLineRange, type SelectionSide } from "@pierre/diffs/react";
import DiffWorker from "@pierre/diffs/worker/worker.js?worker";
import { commentAnchor, isOutdated, patchFiles, reviewCommentLines, reviewCommentSent, type CommentAnchor, type DiffLine, type DiffSide, type PatchFile, type ReviewComment } from "@openorc/protocol";
import { ChevronRight, X } from "./icons";
import { applyDiffIcons } from "./icons-diff";
import { patchStat } from "./diff-stat";
import { cn } from "../lib/cn";
import { useTheme } from "../lib/theme";
import { Button, Textarea, TextButton } from "./ui";

const workerFactory = () => new DiffWorker();

/** The line or range a click or drag asks to comment on. */
export interface CommentLocation extends CommentAnchor {
  path: string;
}
export type CommentDraft = CommentLocation;
export interface ReviewCommentState {
  label: string;
  /** Who wrote the comment, when it may not be you. */
  author?: string;
  removeDisabled: boolean;
  reason?: string;
}

/** A saved comment, or null for the draft being written. Non-union on purpose: the viewer's metadata generic distributes over unions. */
interface Annotation {
  comment: ReviewComment | null;
}

/** The width at which a diff reads side by side rather than unified. */
const SPLIT_MIN = 880;

interface DiffViewProps {
  patch: string;
  comments?: ReviewComment[];
  /** A drag or shift-click across line numbers comments on a range. Team review keeps one line per comment. */
  commentRanges?: boolean;
  draft?: CommentDraft | null;
  onRequestComment?: (location: CommentLocation) => void;
  onSubmitDraft?: (body: string) => void;
  onCancelDraft?: () => void;
  onRemoveComment?: (id: string) => void;
  commentState?: (id: string) => ReviewCommentState;
  onFirstPaint?: (ms: number) => void;
}

function isDark(): boolean {
  const stamped = document.documentElement.getAttribute("data-theme");
  if (stamped === "dark") return true;
  if (stamped === "light") return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

type FileStatus = "added" | "deleted" | "renamed" | "modified";
const statusTone: Record<FileStatus, string> = { added: "text-ok", deleted: "text-bad", renamed: "text-warn", modified: "text-ink-3" };
const statusLetter: Record<FileStatus, string> = { added: "A", deleted: "D", renamed: "R", modified: "M" };
const statusLabel: Record<FileStatus, string> = { added: "Added", deleted: "Deleted", renamed: "Renamed", modified: "Modified" };

interface DiffFile extends PatchFile {
  status: FileStatus;
  insertions: number;
  deletions: number;
}

function statusOf(chunk: string): FileStatus {
  if (/^new file mode /m.test(chunk)) return "added";
  if (/^deleted file mode /m.test(chunk)) return "deleted";
  if (/^rename to /m.test(chunk)) return "renamed";
  return "modified";
}

/** One patch string, split per file so each file gets its own header, click handler and annotations. */
function splitPatch(patch: string): DiffFile[] {
  return patchFiles(patch).map((file) => {
    const stat = patchStat(file.chunk);
    return { ...file, status: statusOf(file.chunk), insertions: stat.insertions, deletions: stat.deletions };
  });
}

/** How many commented files may open themselves before the reader has to ask. */
const MAX_OPEN_ON_ARRIVAL = 5;

/**
 * Which files are open when the review surface first appears. Everything else
 * stays folded, and the set tracks the exceptions rather than the rule so a
 * file arriving in a later poll inherits the closed default instead of
 * appearing open because nobody had folded it yet.
 *
 * A folded file renders no PatchDiff at all, so this is the difference between
 * mounting one worker-highlighted view and mounting one per changed file: a
 * 189-file branch opened every one of them against a two-worker pool.
 */
function initiallyExpanded(files: DiffFile[], comments: ReviewComment[]): ReadonlySet<string> {
  // A lone file has no list to skim and nothing to save: folding it hides the only thing
  // the panel is for, to spare a view that would have been the floor anyway.
  if (files.length === 1) return new Set(files.map((file) => file.path));
  // A reviewer's own notes should not open hidden. "Every file I commented on" is
  // unbounded though, and bounding what mounts is the whole point, so this opens the
  // first few and lets the rest state their count on a folded header.
  const commented = files.filter((file) => comments.some((comment) => comment.path === file.path));
  return new Set(commented.slice(0, MAX_OPEN_ON_ARRIVAL).map((file) => file.path));
}

/**
 * The review surface. Highlighting runs in a worker pool; phase 0 measured a
 * 10k-line patch at 28 ms to first paint and 118 ms to settle this way.
 * Files arrive folded to their header row, so a long changeset opens as a list
 * of what changed; clicking a line number starts a comment, and comments
 * render inline.
 */
export function DiffView({ patch, comments = [], commentRanges = false, draft = null, onRequestComment, onSubmitDraft, onCancelDraft, onRemoveComment, commentState, onFirstPaint }: DiffViewProps) {
  const choice = useTheme((s) => s.choice);
  const [dark, setDark] = useState(isDark());
  const mountedAt = useRef(performance.now());
  const files = useMemo(() => splitPatch(patch), [patch]);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => initiallyExpanded(files, comments));
  const box = useRef<HTMLDivElement | null>(null);
  const foldAnchor = useRef<{ header: HTMLButtonElement; scroller: HTMLElement; top: number } | null>(null);
  const [split, setSplit] = useState(false);

  useLayoutEffect(() => {
    const anchor = foldAnchor.current;
    foldAnchor.current = null;
    if (!anchor) return;
    // A sticky header can be far below its section's start. When its code is
    // removed, move the scroll position with it before the next paint.
    const { header, scroller, top } = anchor;
    scroller.scrollTop += header.getBoundingClientRect().top - scroller.getBoundingClientRect().top - top;
  }, [expanded]);

  // Side by side once each half has room for a line of code, the way GitHub's split view
  // reads: an expanded panel crosses the line, a docked one stays unified.
  useEffect(() => {
    const node = box.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => setSplit((entry?.contentRect.width ?? 0) >= SPLIT_MIN));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    setDark(isDark());
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setDark(isDark());
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [choice]);

  useEffect(() => {
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => onFirstPaint?.(Math.round(performance.now() - mountedAt.current)));
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Each patch owns one paint measurement; callback identity changes must not schedule another measurement.
  }, [patch]);

  // A comment being written must be visible, whatever the reader left folded.
  useEffect(() => {
    const path = draft?.path;
    if (path) setExpanded((set) => (set.has(path) ? set : new Set([...set, path])));
  }, [draft?.path]);

  const toggle = (path: string, header: HTMLButtonElement) => {
    const scroller = header.closest<HTMLElement>(".diffscroll");
    if (scroller) foldAnchor.current = { header, scroller, top: header.getBoundingClientRect().top - scroller.getBoundingClientRect().top };
    setExpanded((set) => {
      const next = new Set(set);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  };

  const theme = dark ? "github-dark" : "github-light";

  return (
    <WorkerPoolContextProvider
      poolOptions={{ workerFactory, poolSize: 2 }}
      highlighterOptions={{ theme: { light: "github-light", dark: "github-dark" }, langs: ["ts", "tsx", "js", "jsx", "json", "css", "html", "md", "yaml", "sh", "py", "rs", "go"] }}
    >
      <div ref={box} className="h-full min-w-0">
        <Virtualizer className="diffscroll h-full overflow-auto" config={{ overscrollSize: 800 }}>
          {files.map((f) => {
            const open = expanded.has(f.path);
            return (
              <section key={f.path} className="diff-file" aria-label={f.path}>
                <FileHeader file={f} open={open} onToggle={(header) => toggle(f.path, header)} commentCount={comments.filter((c) => c.path === f.path).length} />
                {open ? (
                  <FileBlock
                    path={f.path}
                    chunk={f.chunk}
                    theme={theme}
                    diffStyle={split ? "split" : "unified"}
                    comments={comments.filter((c) => c.path === f.path && c.line !== null)}
                    commentRanges={commentRanges}
                    draft={draft?.path === f.path ? draft : null}
                    onRequestComment={onRequestComment}
                    onSubmitDraft={onSubmitDraft}
                    onCancelDraft={onCancelDraft}
                    onRemoveComment={onRemoveComment}
                    commentState={commentState}
                  />
                ) : null}
              </section>
            );
          })}
        </Virtualizer>
      </div>
    </WorkerPoolContextProvider>
  );
}

/**
 * The fold. It replaces the diff renderer's own file header so the path, the
 * change letter and the two counts read in the app's own ink ramp, and it
 * stays put while its file scrolls past.
 */
function FileHeader({ file, open, onToggle, commentCount }: { file: DiffFile; open: boolean; onToggle: (header: HTMLButtonElement) => void; commentCount: number }) {
  const cut = file.path.lastIndexOf("/");
  const directory = cut === -1 ? "" : file.path.slice(0, cut + 1);
  const name = cut === -1 ? file.path : file.path.slice(cut + 1);
  return (
    <button
      type="button"
      onClick={(event) => onToggle(event.currentTarget)}
      aria-expanded={open}
      title={`${statusLabel[file.status]} · ${file.path}`}
      className="diff-file-header group flex w-full items-center gap-2 px-2 text-left"
    >
      <ChevronRight size={12} className={cn("shrink-0 text-ink-4 transition-transform group-hover:text-ink-3", open && "rotate-90")} />
      <span className={cn("w-3 shrink-0 text-center font-mono text-xs font-medium", statusTone[file.status])} aria-hidden="true">
        {statusLetter[file.status]}
      </span>
      <span className="min-w-0 truncate font-mono text-sm">
        {directory ? <span className="text-ink-4">{directory}</span> : null}
        <span className="text-ink-2 group-hover:text-ink">{name}</span>
      </span>
      {commentCount > 0 ? (
        <span className="shrink-0 text-xs text-ink-4">
          {commentCount} comment{commentCount === 1 ? "" : "s"}
        </span>
      ) : null}
      <span className="ml-auto shrink-0 font-mono text-xs tabular">
        {file.insertions > 0 ? <span className="text-ok">+{file.insertions}</span> : null}
        {file.insertions > 0 && file.deletions > 0 ? " " : null}
        {file.deletions > 0 ? <span className="text-bad">-{file.deletions}</span> : null}
      </span>
    </button>
  );
}

const selectionSide = (side: DiffSide): SelectionSide => (side === "old" ? "deletions" : "additions");
const diffSide = (side: SelectionSide | undefined): DiffSide => (side === "deletions" ? "old" : "new");

/** The draft's lines, highlighted while the comment is written. */
function draftSelection(draft: CommentDraft | null): SelectedLineRange | null {
  if (!draft) return null;
  return { start: draft.startLine ?? draft.line, side: selectionSide(draft.startSide ?? draft.side), end: draft.line, endSide: selectionSide(draft.side) };
}

/** "Lines 10-12", with -/+ marks once a removed line is involved. Null for one line. */
function rangeLabel(anchor: Pick<ReviewComment, "startLine" | "startSide" | "line" | "side">): string | null {
  const lines = anchor.startLine === null ? null : reviewCommentLines(anchor);
  return lines === null ? null : `Lines ${lines}`;
}

/** Said of a comment, or a draft, whose lines no longer read as they did when it was written. */
function changedLabel(anchor: Pick<ReviewComment, "startLine" | "line">): string {
  return `Outdated: ${anchor.startLine !== null ? "these lines" : `line ${anchor.line}`} changed`;
}

function FileBlock({
  path,
  chunk,
  theme,
  diffStyle,
  comments,
  commentRanges,
  draft,
  onRequestComment,
  onSubmitDraft,
  onCancelDraft,
  onRemoveComment,
  commentState,
}: {
  path: string;
  chunk: string;
  theme: string;
  diffStyle: "unified" | "split";
  comments: ReviewComment[];
  commentRanges: boolean;
  draft: CommentDraft | null;
  onRequestComment?: (location: CommentLocation) => void;
  onSubmitDraft?: (body: string) => void;
  onCancelDraft?: () => void;
  onRemoveComment?: (id: string) => void;
  commentState?: (id: string) => ReviewCommentState;
}) {
  // A comment whose lines changed would otherwise sit beside whatever now has their numbers.
  const outdated = useMemo(() => comments.filter((c) => isOutdated(c, chunk)), [comments, chunk]);
  // So would a draft whose lines change while it is written.
  const draftOutdated = draft !== null && isOutdated(draft, chunk);
  const annotations = useMemo(() => {
    const list: { side: "deletions" | "additions"; lineNumber: number; metadata: Annotation }[] = comments
      .filter((c) => !outdated.includes(c))
      .map((c) => ({
        side: c.side === "old" ? "deletions" : "additions",
        lineNumber: c.line as number,
        metadata: { comment: c },
      }));
    if (draft && !draftOutdated) list.push({ side: draft.side === "old" ? "deletions" : "additions", lineNumber: draft.line, metadata: { comment: null } });
    return list;
  }, [comments, outdated, draft, draftOutdated]);

  // What is typed belongs to the draft's lines rather than to its composer, so
  // the composer can move out of the code without losing it. A draft on other
  // lines, or none, starts over.
  const draftKey = draft ? `${draft.startSide}${draft.startLine}:${draft.side}${draft.line}` : null;
  const [typed, setTyped] = useState({ key: draftKey, body: "" });
  if (typed.key !== draftKey) setTyped({ key: draftKey, body: "" });

  const requestComment = useCallback(
    (from: DiffLine, to: DiffLine) => {
      const anchor = commentAnchor(chunk, from, to);
      if (anchor) onRequestComment?.({ path, ...anchor });
    },
    [chunk, path, onRequestComment],
  );
  const selectsRanges = commentRanges && Boolean(onRequestComment);
  // The lines under the pointer while a drag is in progress; the viewer draws only the selection it is given.
  const [dragging, setDragging] = useState<SelectedLineRange | null>(null);
  // Stable while dragging: new options would make the viewer render the whole file again on every move.
  const options = useMemo((): FileDiffOptions<Annotation, undefined> => {
    const base: FileDiffOptions<Annotation, undefined> = {
      diffStyle,
      diffIndicators: "bars",
      theme: { light: "github-light", dark: "github-dark" },
      themeType: theme === "github-dark" ? "dark" : "light",
      // The fold above carries the filename, the letter and the counts.
      disableFileHeader: true,
      onPostRender: applyDiffIcons,
      enableLineSelection: selectsRanges,
    };
    if (selectsRanges) {
      return {
        ...base,
        onLineSelectionStart: setDragging,
        onLineSelectionChange: setDragging,
        onLineSelectionEnd: (range) => {
          setDragging(null);
          // Clicking the drafted line again clears the viewer's selection; the draft stays.
          if (!range) return;
          requestComment({ line: range.start, side: diffSide(range.side) }, { line: range.end, side: diffSide(range.endSide ?? range.side) });
        },
      };
    }
    if (!onRequestComment) return base;
    return {
      ...base,
      onLineNumberClick: (p: { lineNumber: number; annotationSide?: SelectionSide }) => {
        const point = { line: p.lineNumber, side: diffSide(p.annotationSide) };
        requestComment(point, point);
      },
    };
  }, [diffStyle, theme, selectsRanges, onRequestComment, requestComment]);

  const composer = draft ? (
    <DraftComposer
      label={draftOutdated ? changedLabel(draft) : rangeLabel(draft)}
      changedText={draftOutdated ? draft.lineText : null}
      body={typed.body}
      onBodyChange={(body) => setTyped({ key: draftKey, body })}
      onSubmit={(body) => onSubmitDraft?.(body)}
      onCancel={() => onCancelDraft?.()}
    />
  ) : null;

  return (
    <>
      {outdated.map((comment) => (
        <CommentAnnotation key={comment.id} comment={comment} state={commentState?.(comment.id)} onRemove={() => onRemoveComment?.(comment.id)} outdated />
      ))}
      {draftOutdated ? composer : null}
      <PatchDiff<Annotation>
        patch={chunk}
        lineAnnotations={annotations}
        selectedLines={selectsRanges ? (dragging ?? (draftOutdated ? null : draftSelection(draft))) : undefined}
        renderAnnotation={(a) => {
          const comment = a.metadata.comment;
          return comment === null ? composer : <CommentAnnotation comment={comment} state={commentState?.(comment.id)} onRemove={() => onRemoveComment?.(comment.id)} />;
        }}
        options={options}
      />
    </>
  );
}

function CommentAnnotation({ comment, state, onRemove, outdated = false }: { comment: ReviewComment; state?: ReviewCommentState; onRemove: () => void; outdated?: boolean }) {
  const range = rangeLabel(comment);
  return (
    <div className={cn("my-1 mx-3 rounded-md border bg-surface px-3 py-2 text-sm font-sans", outdated && "border-dashed border-line-strong", !outdated && "border-line")}>
      <div className="flex items-center gap-2 text-xs text-ink-3 mb-1">
        <span className="font-medium text-ink-2">{state?.author ?? "You"}</span>
        {range ? <span className="text-ink-2">{range}</span> : null}
        <span>{state?.label ?? (reviewCommentSent(comment) ? "sent to the agent" : "not sent yet")}</span>
        {outdated ? <span>· {changedLabel(comment)}</span> : null}
        <TextButton
          onClick={onRemove}
          disabled={state?.removeDisabled}
          tone="danger"
          className="ml-auto shrink-0 disabled:cursor-default"
          aria-label="Remove comment"
          title={state?.reason ?? "Remove comment"}
        >
          <X size={12} />
        </TextButton>
      </div>
      {outdated && comment.lineText !== null ? <div className="font-mono text-xs text-ink-3 whitespace-pre overflow-x-auto mb-1">{comment.lineText}</div> : null}
      <div className="text-ink whitespace-pre-wrap">{comment.body}</div>
    </div>
  );
}

function DraftComposer({
  label,
  changedText,
  body,
  onBodyChange,
  onSubmit,
  onCancel,
}: {
  label: string | null;
  /** What the lines said when the draft began, once they no longer do. */
  changedText: string | null;
  body: string;
  onBodyChange: (body: string) => void;
  onSubmit: (body: string) => void;
  onCancel: () => void;
}) {
  return (
    <div className="my-1 mx-3 rounded-md border border-line-strong bg-surface p-2 font-sans">
      {label ? <p className="text-xs text-ink-3 mb-1.5">{label}</p> : null}
      {changedText !== null ? <div className="font-mono text-xs text-ink-3 whitespace-pre overflow-x-auto mb-1.5">{changedText}</div> : null}
      <Textarea
        autoFocus
        rows={3}
        value={body}
        onChange={(e) => onBodyChange(e.target.value)}
        placeholder="What should change here?"
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && body.trim()) onSubmit(body.trim());
          if (e.key === "Escape") onCancel();
        }}
      />
      <div className="flex justify-end gap-2 mt-2">
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" disabled={!body.trim()} onClick={() => onSubmit(body.trim())}>
          Add comment
        </Button>
      </div>
    </div>
  );
}
