import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { defaultRehypePlugins, defaultUrlTransform, type Components, type ExtraProps, type StreamdownProps, type UrlTransform } from "streamdown";
import { ChevronRight, Image, FolderOpen, Loader2, X, ZoomIn, ZoomOut } from "./icons";
import { cn } from "../lib/cn";
import { imageSource, isImagePath, localPath } from "../../../shared/image-paths";
import { fileReference } from "../../../shared/file-reference";
import { useLayout, type FileSelection } from "../lib/layout";
import { citationLinks, type Block } from "@openorc/client";
import { COMMIT_ID } from "@openorc/protocol";
import { useRpc } from "../lib/client";
import { Button } from "./ui";
import { RichText } from "./RichText";
import { codePathLinks } from "../lib/code-path-links";
import { rehypeMentionNames } from "../lib/mention-names";
import { CoversPreview } from "../lib/browser-preview";
import { ImageDownload } from "./ImageDownload";

/** The thread whose commits a reply's ids name: in its folder on this Mac, or in the cloud. */
export type CommitScope = { threadId: string; hosted: boolean };

type ImageSelection = { src: string; label: string; path: string | null; download?: (() => Promise<unknown>) | undefined; onInvalidated?: ((close: () => void) => () => void) | undefined };
const MediaContext = createContext<{
  basePath?: string;
  fileScope?: FileSelection["scope"];
  fileLinks?: "open" | "cite";
  commits?: CommitScope | undefined;
  mentionNames?: ReadonlyMap<string, string> | undefined;
  openImage: (image: ImageSelection) => void;
}>({
  openImage: () => {},
});

export const useThreadMentionNames = () => useContext(MediaContext).mentionNames;
/** The workspace path and image viewer, for images drawn outside Markdown like the task editor's. */
export const useThreadMedia = () => useContext(MediaContext);

/** Where a transcript's files are: the folder its links resolve in and the scope its file panel reads, or elsewhere. */
export interface MediaScope {
  basePath?: string;
  fileScope?: FileSelection["scope"];
  /** "cite" when the files live elsewhere: links to them read as references. */
  fileLinks?: "open" | "cite";
  /** Set where a commit's id in a reply can open that commit. */
  commits?: CommitScope | undefined;
}

export function ThreadMedia({
  children,
  basePath,
  scopeKey,
  fileScope,
  fileLinks = "open",
  commits,
  mentionNames: ownNames,
}: MediaScope & {
  children: ReactNode;
  scopeKey: string;
  mentionNames?: ReadonlyMap<string, string> | undefined;
}) {
  const inherited = useContext(MediaContext);
  const mentionNames = ownNames ?? inherited.mentionNames;
  const [selected, select] = useState<ImageSelection | null>(null);
  useEffect(() => select(null), [scopeKey]);
  useEffect(() => selected?.onInvalidated?.(() => select(null)), [selected]);
  const opener = useRef<HTMLElement | null>(null);
  const openImage = useCallback((image: ImageSelection) => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    select(image);
  }, []);
  // Callers pass the scope as a fresh literal; keying on its fields keeps every image and link below from re-rendering.
  const scopeKind = fileScope?.kind;
  const scopeId = fileScope?.id;
  const scopeDirectory = fileScope?.kind === "project" ? fileScope.workingDirectory : undefined;
  const commitThread = commits?.threadId;
  const commitsHosted = commits?.hosted === true;
  const context = useMemo(() => {
    let scope: FileSelection["scope"] | undefined;
    if (scopeKind && scopeId !== undefined) scope = scopeKind === "project" ? { kind: scopeKind, id: scopeId, workingDirectory: scopeDirectory } : { kind: scopeKind, id: scopeId };
    const commitScope = commitThread === undefined ? undefined : { threadId: commitThread, hosted: commitsHosted };
    return { basePath, openImage, fileScope: scope, fileLinks, commits: commitScope, mentionNames };
  }, [basePath, openImage, scopeKind, scopeId, scopeDirectory, fileLinks, commitThread, commitsHosted, mentionNames]);
  return (
    <MediaContext.Provider value={context}>
      {children}
      <BaseDialog.Root
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open) select(null);
        }}
      >
        <BaseDialog.Portal>
          <CoversPreview />
          <BaseDialog.Backdrop className="fixed inset-0 z-50 bg-black/60" />
          <BaseDialog.Popup aria-label="Image viewer" finalFocus={opener} className="image-viewer">
            {selected ? <ImageViewer key={selected.src} image={selected} /> : null}
          </BaseDialog.Popup>
        </BaseDialog.Portal>
      </BaseDialog.Root>
    </MediaContext.Provider>
  );
}

function ImageViewer({ image }: { image: ImageSelection }) {
  const [zoom, setZoom] = useState<number | null>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [failed, setFailed] = useState(false);
  const zoomBy = (step: number) => setZoom((value) => Math.min(4, Math.max(0.25, (value ?? 1) + step)));
  const zoomed = zoom !== null && size ? { width: size.width * zoom, height: size.height * zoom } : undefined;
  return (
    <>
      <header className="image-viewer-head">
        <BaseDialog.Title className="min-w-0 truncate text-base">{image.label}</BaseDialog.Title>
        <BaseDialog.Description className="mr-auto shrink-0 whitespace-nowrap text-xs text-ink-3">
          {size && !image.download ? `${size.width} × ${size.height}` : "Image preview"}
        </BaseDialog.Description>
        <BaseDialog.Close aria-label="Close image viewer" className="shrink-0 rounded-full p-1.5 text-ink-3 hover:bg-surface-2 hover:text-ink">
          <X size={18} />
        </BaseDialog.Close>
      </header>
      <div className="image-viewer-canvas" tabIndex={0} aria-label="Image canvas">
        {failed ? (
          <div role="status" className="grid gap-2 px-6 py-10 text-center text-sm text-ink-3">
            <Image size={32} className="mx-auto" />
            <p>Image unavailable</p>
            <p>{image.path ? "The file may have moved, been deleted, or exceeded 32 MB." : "The image data could not be displayed."}</p>
          </div>
        ) : (
          <img
            src={image.src}
            alt={image.label}
            onError={() => setFailed(true)}
            onLoad={(event) => setSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
            className="image-viewer-picture"
            data-fit={zoomed ? undefined : ""}
            style={zoomed}
          />
        )}
      </div>
      <footer className="image-viewer-foot">
        <div className="image-viewer-zoom" role="group" aria-label="Zoom">
          <Button variant="ghost" aria-label="Zoom out" disabled={failed || zoom === 0.25} onClick={() => zoomBy(-0.25)}>
            <ZoomOut size={16} />
          </Button>
          <Button variant="ghost" aria-label="Actual size" onClick={() => setZoom(1)}>
            {zoom === null ? "100%" : `${Math.round(zoom * 100)}%`}
          </Button>
          <Button variant="ghost" aria-label="Zoom in" disabled={failed || zoom === 4} onClick={() => zoomBy(0.25)}>
            <ZoomIn size={16} />
          </Button>
          <Button variant="ghost" onClick={() => setZoom(null)}>
            Fit
          </Button>
          <ImageFileAction image={image} />
        </div>
        {image.path ? (
          <p className="max-w-full truncate text-xs text-ink-3" data-tip={image.path}>
            {image.path}
          </p>
        ) : null}
      </footer>
    </>
  );
}

function ImageFileAction({ image }: { image: ImageSelection }) {
  if (image.download) return <ImageDownload name={image.label} download={image.download} />;
  if (!image.path) return null;
  return (
    <Button variant="ghost" aria-label="Show image in folder" onClick={() => window.openorc.revealFile(image.path!)}>
      <FolderOpen size={16} />
    </Button>
  );
}

export function ThreadImage({
  src = "",
  objectUrl,
  alt = "Image",
  compact = false,
  download,
  onInvalidated,
  onError,
}: {
  src?: string;
  /** A picture this window already holds, such as a cloud file's authorized preview; never a path or an agent's link. */
  objectUrl?: string | undefined;
  alt?: string;
  compact?: boolean;
  download?: ImageSelection["download"];
  onInvalidated?: ImageSelection["onInvalidated"];
  onError?: (() => void) | undefined;
}) {
  const { basePath, openImage } = useContext(MediaContext);
  const [failed, setFailed] = useState(false);
  const source = objectUrl ?? imageSource(src, basePath);
  const path = localPath(src, basePath);
  const label = alt || path?.split(/[\\/]/).pop() || "Image";
  if (!source) return <span className="text-sm text-ink-3">Image preview unavailable</span>;
  return (
    <button
      type="button"
      aria-label={`View image: ${label}`}
      onClick={() => openImage({ src: source, label, path, download, onInvalidated })}
      className="my-2 block max-w-full overflow-hidden rounded-xl bg-surface-2 text-left hover:bg-surface-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      {failed ? (
        <span className="flex items-center gap-2 px-4 py-6 text-sm text-ink-3">
          <Image size={18} />
          Image unavailable · {label}
        </span>
      ) : (
        <img
          src={source}
          alt={label}
          loading="lazy"
          onError={() => {
            setFailed(true);
            onError?.();
          }}
          className={compact ? "h-24 max-w-56 object-cover" : "block max-h-80 max-w-full object-contain"}
        />
      )}
      {!compact && !failed ? (
        <span className="flex items-center gap-2 px-3 py-2 text-xs text-ink-3">
          <Image size={12} />
          <span className="truncate">{label}</span>
          <span className="ml-auto shrink-0">View image</span>
        </span>
      ) : null}
    </button>
  );
}

export function ThreadLink({ href = "", children }: ComponentProps<"a">) {
  const { basePath, openImage, fileScope } = useContext(MediaContext);
  const reference = fileReference(href, basePath);
  const path = reference?.path ?? null;
  const source = imageSource(href, basePath);
  const external = /^https?:\/\//i.test(href);
  const onClick = () => {
    if (source) openImage({ src: source, label: path?.split(/[\\/]/).pop() || "Image", path });
    else if (reference && fileScope) useLayout.getState().openFile({ ...reference, scope: fileScope });
    else if (path) window.openorc.revealFile(path);
  };
  return (
    <a
      href={href || undefined}
      target={external ? "_blank" : undefined}
      rel={external ? "noopener noreferrer" : undefined}
      onClick={(event) => {
        // Main routes native link gestures (including middle-click) into Preview.
        if (external) return;
        event.preventDefault();
        onClick();
      }}
      data-tip={path && !source ? `${fileScope ? "View code" : "Show in folder"}: ${path}${reference?.line ? `:${reference.line}` : ""}` : href}
    >
      {children}
    </a>
  );
}

/** The commit an id names in the thread: read from its folder on this Mac, or found among a cloud thread's own commits. */
function useNamedCommit({ threadId, hosted }: CommitScope, id: string): { sha: string; subject: string; url: string | null } | null {
  // An id that names no commit is not an error to try again.
  const local = useRpc("git.threadCommit", { threadId, sha: id }, { enabled: !hosted, retry: false });
  const cloud = useRpc("hosted.review.commits", { threadId }, { enabled: hosted, retry: false });
  if (hosted) {
    const commit = cloud.data?.commits.find((entry) => entry.sha.startsWith(id));
    return commit ? { sha: commit.sha, subject: commit.subject, url: null } : null;
  }
  return local.data ? { sha: local.data.commit.sha, subject: local.data.commit.subject, url: local.data.url } : null;
}

/** A commit's id as the way to the commit: its page on GitHub once origin has it, else the commit in the thread's Commits. */
function CommitLink({ scope, id, children }: { scope: CommitScope; id: string; children: ReactNode }) {
  const commit = useNamedCommit(scope, id);
  if (!commit) return children;
  if (commit.url) return <ThreadLink href={commit.url}>{children}</ThreadLink>;
  return (
    <a
      href={`#${commit.sha}`}
      data-tip={`View commit: ${commit.subject}`}
      onClick={(event) => {
        event.preventDefault();
        useLayout.getState().openCommit(scope.threadId, commit.sha);
      }}
    >
      {children}
    </a>
  );
}

/** Inline code as the renderer draws it. Where it is a commit's id and the thread holds that commit, it opens the commit. */
function ThreadCode({ node: _node, className, children, ...props }: ComponentProps<"code"> & ExtraProps) {
  const { commits } = useContext(MediaContext);
  const code = (
    <code className={cn("rounded bg-muted px-1.5 py-0.5 font-mono text-sm", className)} data-streamdown="inline-code" {...props}>
      {children}
    </code>
  );
  const id = typeof children === "string" && COMMIT_ID.test(children) ? children : null;
  return commits && id ? (
    <CommitLink scope={commits} id={id}>
      {code}
    </CommitLink>
  ) : (
    code
  );
}

export const threadMarkdownComponents: Components = {
  inlineCode: ThreadCode,
  a: (props) => <ThreadLink href={typeof props.href === "string" ? props.href : ""}>{props.children as ReactNode}</ThreadLink>,
  img: (props) => <ThreadImage key={String(props.src)} src={typeof props.src === "string" ? props.src : ""} alt={typeof props.alt === "string" ? props.alt : "Image"} />,
};
export const threadUrlTransform: UrlTransform = (url, key, node) => (localPath(url) || imageSource(url) ? url : defaultUrlTransform(url, key, node));

/** Resolve relative citations in the workspace before Markdown's URL sanitizer runs. */
export function ThreadRichText({
  codePaths = false,
  ...props
}: StreamdownProps & {
  /**
   * Inline code that names a file links to it. Only an agent's own words ask: it writes paths from the folder it works
   * in, while a document's or a fetched page's are from somewhere else, such as the repository's root for a file under
   * docs/, or another project altogether.
   */
  codePaths?: boolean;
}) {
  const { basePath, fileScope, fileLinks, mentionNames } = useContext(MediaContext);
  // A path in inline code is a link only where a link can open it: in the Files tool, or in the folder it is in.
  const pathLinks = Boolean(codePaths) && fileLinks !== "cite" && Boolean(fileScope || basePath);
  const rehypePlugins = useMemo<NonNullable<StreamdownProps["rehypePlugins"]>>(() => {
    const plugins: NonNullable<StreamdownProps["rehypePlugins"]> = [
      defaultRehypePlugins.raw!,
      ...(pathLinks ? [codePathLinks] : []),
      [localFileLinks, { basePath, cite: fileLinks === "cite" }],
      ...Object.entries(defaultRehypePlugins)
        .filter(([name]) => name !== "raw")
        .map(([, plugin]) => plugin),
    ];
    // Streamdown keys its parser cache by serialized plugin options. A Map
    // serializes as {}, which would reuse names from another conversation.
    if (mentionNames?.size) plugins.push([rehypeMentionNames, { names: [...mentionNames] }]);
    return plugins;
  }, [basePath, fileLinks, mentionNames, pathLinks]);
  const text = typeof props.children === "string" ? citationLinks(props.children) : props.children;
  return (
    <RichText {...props} components={threadMarkdownComponents} rehypePlugins={rehypePlugins} urlTransform={threadUrlTransform}>
      {text}
    </RichText>
  );
}

type MarkdownNode = { tagName?: string; properties?: Record<string, unknown>; children?: MarkdownNode[] };

function localLinkAttribute(tagName: string | undefined): "href" | "src" | null {
  if (tagName === "a") return "href";
  if (tagName === "img") return "src";
  return null;
}

function imageViewingLabel(status: string): string {
  if (status === "running") return "Viewing image";
  if (status === "success") return "Viewed image";
  if (status === "error") return "Image viewing failed";
  return "Image viewing interrupted";
}

function imageGenerationLabel(status: string): string {
  if (status === "running") return "Generating image";
  if (status === "success") return "Generated image";
  if (status === "error") return "Image generation failed";
  return "Image generation interrupted";
}
/** A link to a file this Mac cannot open: its words, the path on hover. */
function cite(node: MarkdownNode, url: string): void {
  node.tagName = "span";
  node.properties = { title: url };
}

/** A local link's URL as a path under the workspace, so the sanitizer keeps it. */
function resolveLink(node: MarkdownNode, key: "href" | "src", url: string, basePath: string | undefined): void {
  const reference = key === "href" ? fileReference(url, basePath) : null;
  if (reference && node.properties && (basePath || /^file:/i.test(url) || reference.line)) {
    node.properties[key] = reference.path.split("/").map(encodeURIComponent).join("/") + (reference.line ? `#L${reference.line}${reference.endLine ? `-L${reference.endLine}` : ""}` : "");
  } else if (basePath || /^file:/i.test(url)) {
    const path = localPath(url, basePath);
    if (path && node.properties) node.properties[key] = path.split("/").map(encodeURIComponent).join("/");
  }
}

/**
 * Normalize local file URLs before the standard sanitizer removes file: links. With `cite`, the files live elsewhere:
 * a link to one reads as its words, the path on hover, as the phone shows it.
 */
function localFileLinks(options?: { basePath?: string; cite?: boolean }) {
  return (tree: MarkdownNode) => {
    const visit = (node: MarkdownNode) => {
      const key = localLinkAttribute(node.tagName);
      const url = key ? node.properties?.[key] : undefined;
      if (key && typeof url === "string") {
        if (options?.cite && key === "href" && localPath(url, ".")) cite(node, url);
        else resolveLink(node, key, url, options?.basePath);
      }
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}
export const threadRehypePlugins: StreamdownProps["rehypePlugins"] = [
  defaultRehypePlugins.raw!,
  localFileLinks,
  ...Object.entries(defaultRehypePlugins)
    .filter(([name]) => name !== "raw")
    .map(([, plugin]) => plugin),
];

export function ImageViewRow({ block }: { block: Extract<Block, { kind: "activity" }> }) {
  const [open, setOpen] = useState(true);
  const detail = block.detail as { path?: unknown } | undefined;
  const path = typeof detail?.path === "string" ? detail.path : "";
  const filename = path.split(/[\\/]/).pop();
  const label = imageViewingLabel(block.status);
  return (
    <section aria-label="Image viewing">
      <button type="button" data-state={block.status} aria-expanded={open} onClick={() => setOpen((value) => !value)} className={cn("tool-row group", block.status === "error" && "text-bad")}>
        <Image size={16} className="shrink-0" />
        <span className="shrink-0">{label}</span>
        {filename ? (
          <span className="tool-row-object" data-tip={path}>
            {filename}
          </span>
        ) : null}
        {block.status === "running" ? <Loader2 size={14} className="tool-row-live" /> : null}
        <ChevronRight size={12} className={cn("tool-row-chevron", open && "rotate-90")} />
      </button>
      {open ? (
        <div className="ml-6 min-w-0">
          {path ? <ThreadImage key={path} src={path} alt={filename || "Viewed image"} /> : <p className="my-2 text-sm text-ink-3">Image preview unavailable · No image path was recorded.</p>}
          {path ? <p className="mb-2 break-all text-xs text-ink-3">{path}</p> : null}
          {block.status === "error" && block.text && block.text !== path ? <p className="my-1 whitespace-pre-wrap break-words text-sm text-bad">{block.text}</p> : null}
        </div>
      ) : null}
    </section>
  );
}

export function ImageGenerationRow({ block }: { block: Extract<Block, { kind: "activity" }> }) {
  const detail = block.detail as { savedPath?: unknown; revisedPrompt?: unknown } | undefined;
  const path = block.imagePath ?? (typeof detail?.savedPath === "string" ? detail.savedPath : null);
  const running = block.status === "running";
  const label = imageGenerationLabel(block.status);
  return (
    <section aria-label="Image generation">
      <div data-state={block.status} role="status" className="flex min-h-7.5 items-center gap-2 text-base text-ink-4">
        <Image size={14} />
        <span>{label}</span>
        {running ? <Loader2 size={14} className="tool-row-live" /> : null}
      </div>
      {running ? (
        <div className="mt-2 grid h-40 w-64 max-w-full place-content-center gap-2 rounded-xl bg-surface-2 text-center text-xs text-ink-3">
          <Image size={28} className="mx-auto motion-safe:animate-pulse" />
          Creating your image…
        </div>
      ) : null}
      {block.status === "success" && path && isImagePath(path) ? <ThreadImage src={path} alt={path.split(/[\\/]/).pop()} /> : null}
      {block.status === "success" && !path ? <p className="mt-1 text-xs text-ink-3">Generation completed without a saved image preview.</p> : null}
      {block.status === "error" && block.text ? <p className="mt-1 text-sm text-bad whitespace-pre-wrap break-words">{block.text}</p> : null}
      {typeof detail?.revisedPrompt === "string" ? (
        <details className="mt-1 text-xs text-ink-3">
          <summary>Image prompt</summary>
          <p className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words">{detail.revisedPrompt}</p>
        </details>
      ) : null}
    </section>
  );
}
