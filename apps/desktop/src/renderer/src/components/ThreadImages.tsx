import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { defaultRehypePlugins, defaultUrlTransform, type Components, type StreamdownProps, type UrlTransform } from "streamdown";
import { ChevronRight, Image, FolderOpen, X, ZoomIn, ZoomOut } from "./icons";
import { imageSource, isImagePath, localPath } from "../../../shared/image-paths";
import { fileReference } from "../../../shared/file-reference";
import { useLayout, type FileSelection } from "../lib/layout";
import type { Block } from "../lib/transcript";
import { Button } from "./ui";
import { RichText } from "./RichText";
import { rehypeMentionNames } from "../lib/mention-names";
import { CoversPreview } from "../lib/browser-preview";

type ImageSelection = { src: string; label: string; path: string | null };
const MediaContext = createContext<{ basePath?: string; fileScope?: FileSelection["scope"]; mentionNames?: ReadonlyMap<string, string> | undefined; openImage: (image: ImageSelection) => void }>({
  openImage: () => {},
});

export const useThreadMentionNames = () => useContext(MediaContext).mentionNames;

export function ThreadMedia({
  children,
  basePath,
  scopeKey,
  fileScope,
  mentionNames: ownNames,
}: {
  children: ReactNode;
  basePath?: string;
  scopeKey: string;
  fileScope?: FileSelection["scope"];
  mentionNames?: ReadonlyMap<string, string> | undefined;
}) {
  const inherited = useContext(MediaContext);
  const mentionNames = ownNames ?? inherited.mentionNames;
  const [selected, select] = useState<ImageSelection | null>(null);
  useEffect(() => select(null), [scopeKey]);
  const opener = useRef<HTMLElement | null>(null);
  const openImage = useCallback((image: ImageSelection) => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    select(image);
  }, []);
  // Callers pass the scope as a fresh literal; keying on its fields keeps every image and link below from re-rendering.
  const scopeKind = fileScope?.kind;
  const scopeId = fileScope?.id;
  const context = useMemo(
    () => ({ basePath, openImage, fileScope: scopeKind && scopeId !== undefined ? { kind: scopeKind, id: scopeId } : undefined, mentionNames }),
    [basePath, openImage, scopeKind, scopeId, mentionNames],
  );
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
          <BaseDialog.Popup
            aria-label="Image viewer"
            finalFocus={opener}
            className="fixed inset-6 z-50 flex flex-col overflow-hidden rounded-xl border border-line bg-surface text-ink shadow-modal outline-none"
          >
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
  return (
    <>
      <header className="flex min-h-14 shrink-0 flex-wrap items-center gap-2 border-b border-line px-4 py-2">
        <Image size={16} className="shrink-0 text-ink-3" />
        <div className="min-w-24 flex-1">
          <BaseDialog.Title className="truncate text-base font-medium">{image.label}</BaseDialog.Title>
          <BaseDialog.Description className="whitespace-nowrap text-xs text-ink-3">{size ? `${size.width} × ${size.height}` : "Image preview"}</BaseDialog.Description>
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" aria-label="Zoom out" disabled={failed || zoom === 0.25} onClick={() => zoomBy(-0.25)}>
            <ZoomOut size={16} />
          </Button>
          <Button variant="ghost" onClick={() => setZoom(null)}>
            Fit
          </Button>
          <Button variant="ghost" aria-label="Actual size" onClick={() => setZoom(1)}>
            {zoom === null ? "100%" : `${Math.round(zoom * 100)}%`}
          </Button>
          <Button variant="ghost" aria-label="Zoom in" disabled={failed || zoom === 4} onClick={() => zoomBy(0.25)}>
            <ZoomIn size={16} />
          </Button>
          {image.path ? (
            <Button variant="ghost" aria-label="Show image in folder" onClick={() => window.openorc.revealFile(image.path!)}>
              <FolderOpen size={16} />
            </Button>
          ) : null}
        </div>
        <BaseDialog.Close aria-label="Close image viewer" className="rounded-md p-1.5 text-ink-3 hover:bg-surface-2 hover:text-ink">
          <X size={18} />
        </BaseDialog.Close>
      </header>
      <div className="min-h-0 flex-1 overflow-auto bg-surface-2 p-4" tabIndex={0} aria-label="Image canvas">
        {failed ? (
          <div role="status" className="grid h-full place-content-center gap-2 text-center text-sm text-ink-3">
            <Image size={32} className="mx-auto" />
            <p>Image unavailable</p>
            <p>{image.path ? "The file may have moved, been deleted, or exceeded 32 MB." : "The image data could not be displayed."}</p>
          </div>
        ) : (
          <div className="flex min-h-full min-w-full items-center justify-center" style={zoom !== null && size ? { width: size.width * zoom, height: size.height * zoom } : { height: "100%" }}>
            <img
              src={image.src}
              alt={image.label}
              onError={() => setFailed(true)}
              onLoad={(event) => setSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
              className={zoom === null ? "block max-h-full max-w-full object-contain" : "block shrink-0 max-w-none"}
              style={zoom !== null && size ? { width: size.width * zoom, height: size.height * zoom } : undefined}
            />
          </div>
        )}
      </div>
      {image.path ? (
        <footer className="shrink-0 truncate border-t border-line px-4 py-2 text-xs text-ink-3" title={image.path}>
          {image.path}
        </footer>
      ) : null}
    </>
  );
}

export function ThreadImage({ src = "", alt = "Image", compact = false }: { src?: string; alt?: string; compact?: boolean }) {
  const { basePath, openImage } = useContext(MediaContext);
  const [failed, setFailed] = useState(false);
  const source = imageSource(src, basePath);
  const path = localPath(src, basePath);
  const label = alt || path?.split(/[\\/]/).pop() || "Image";
  if (!source) return <span className="text-sm text-ink-3">Image preview unavailable</span>;
  return (
    <button
      type="button"
      aria-label={`View image: ${label}`}
      onClick={() => openImage({ src: source, label, path })}
      className="my-2 block max-w-full overflow-hidden rounded-lg border border-line bg-surface-2 text-left hover:border-line-strong focus-visible:outline-2 focus-visible:outline-accent"
    >
      {failed ? (
        <span className="flex items-center gap-2 px-4 py-6 text-sm text-ink-3">
          <Image size={18} />
          Image unavailable · {label}
        </span>
      ) : (
        <img src={source} alt={label} loading="lazy" onError={() => setFailed(true)} className={compact ? "h-24 max-w-56 object-cover" : "block max-h-80 max-w-full object-contain"} />
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
      title={path && !source ? `${fileScope ? "View code" : "Show in folder"}: ${path}${reference?.line ? `:${reference.line}` : ""}` : href}
    >
      {children}
    </a>
  );
}

export const threadMarkdownComponents: Components = {
  a: (props) => <ThreadLink href={typeof props.href === "string" ? props.href : ""}>{props.children as ReactNode}</ThreadLink>,
  img: (props) => <ThreadImage key={String(props.src)} src={typeof props.src === "string" ? props.src : ""} alt={typeof props.alt === "string" ? props.alt : "Image"} />,
};
export const threadUrlTransform: UrlTransform = (url, key, node) => (localPath(url) || imageSource(url) ? url : defaultUrlTransform(url, key, node));

/** Resolve relative citations in the workspace before Markdown's URL sanitizer runs. */
export function ThreadRichText(props: StreamdownProps) {
  const { basePath, mentionNames } = useContext(MediaContext);
  const rehypePlugins = useMemo<NonNullable<StreamdownProps["rehypePlugins"]>>(() => {
    const plugins: NonNullable<StreamdownProps["rehypePlugins"]> = [
      defaultRehypePlugins.raw!,
      [localFileLinks, { basePath }],
      ...Object.entries(defaultRehypePlugins)
        .filter(([name]) => name !== "raw")
        .map(([, plugin]) => plugin),
    ];
    // Streamdown keys its parser cache by serialized plugin options. A Map
    // serializes as {}, which would reuse names from another conversation.
    if (mentionNames?.size) plugins.push([rehypeMentionNames, { names: [...mentionNames] }]);
    return plugins;
  }, [basePath, mentionNames]);
  return <RichText {...props} components={threadMarkdownComponents} rehypePlugins={rehypePlugins} urlTransform={threadUrlTransform} />;
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
/** Normalize local file URLs before the standard sanitizer removes file: links. */
function localFileLinks(options?: { basePath?: string }) {
  return (tree: MarkdownNode) => {
    const visit = (node: MarkdownNode) => {
      const key = localLinkAttribute(node.tagName);
      const url = key ? node.properties?.[key] : undefined;
      if (key && typeof url === "string") {
        const reference = key === "href" ? fileReference(url, options?.basePath) : null;
        if (reference && node.properties && (options?.basePath || /^file:/i.test(url) || reference.line)) {
          node.properties[key] = reference.path.split("/").map(encodeURIComponent).join("/") + (reference.line ? `#L${reference.line}${reference.endLine ? `-L${reference.endLine}` : ""}` : "");
        } else if (options?.basePath || /^file:/i.test(url)) {
          const path = localPath(url, options?.basePath);
          if (path && node.properties) node.properties[key] = path.split("/").map(encodeURIComponent).join("/");
        }
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

/** Existing ledgers retain the original provider item in detail. */
export function isImageView(block: Block): boolean {
  return block.kind === "activity" && (block.detail as { type?: unknown } | undefined)?.type === "imageView";
}

export function ImageViewRow({ block }: { block: Extract<Block, { kind: "activity" }> }) {
  const [open, setOpen] = useState(true);
  const detail = block.detail as { path?: unknown } | undefined;
  const path = typeof detail?.path === "string" ? detail.path : "";
  const filename = path.split(/[\\/]/).pop();
  const label = imageViewingLabel(block.status);
  return (
    <section aria-label="Image viewing">
      <button
        type="button"
        data-state={block.status}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className={`group flex min-h-6 w-full min-w-0 items-center gap-2 text-left text-sm ${block.status === "error" ? "text-bad" : "text-ink-3 hover:text-ink-2"}`}
      >
        <Image size={16} className="shrink-0" />
        <span className="shrink-0">{label}</span>
        {filename ? (
          <span className="truncate font-mono" title={path}>
            {filename}
          </span>
        ) : null}
        {block.status === "running" ? <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent motion-safe:animate-pulse" /> : null}
        <ChevronRight size={12} className={`ml-auto shrink-0 transition-transform ${open ? "rotate-90" : ""}`} />
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

export function isImageGeneration(block: Block): boolean {
  return block.kind === "activity" && (block.activityKind === "image_generation" || (block.detail as { type?: unknown } | undefined)?.type === "imageGeneration");
}

export function ImageGenerationRow({ block }: { block: Extract<Block, { kind: "activity" }> }) {
  const detail = block.detail as { savedPath?: unknown; revisedPrompt?: unknown } | undefined;
  const path = block.imagePath ?? (typeof detail?.savedPath === "string" ? detail.savedPath : null);
  const running = block.status === "running";
  const label = imageGenerationLabel(block.status);
  return (
    <section className="my-2" aria-label="Image generation">
      <div data-state={block.status} role="status" className="flex items-center gap-2 text-sm text-ink-3">
        <Image size={14} />
        <span>{label}</span>
        {running ? <span className="h-1.5 w-1.5 rounded-full bg-accent motion-safe:animate-pulse" /> : null}
      </div>
      {running ? (
        <div className="mt-2 grid h-40 w-64 max-w-full place-content-center gap-2 rounded-lg border border-line bg-surface-2 text-center text-xs text-ink-3">
          <Image size={28} className="mx-auto motion-safe:animate-pulse" />
          Creating your image…
        </div>
      ) : null}
      {block.status === "success" && path && isImagePath(path) ? <ThreadImage src={path} alt={path.split(/[\\/]/).pop()} /> : null}
      {block.status === "success" && !path ? <p className="mt-1 text-xs text-ink-3">Generation completed without a saved image preview.</p> : null}
      {block.status === "error" && block.text ? <p className="mt-1 text-sm text-bad whitespace-pre-wrap break-words">{block.text}</p> : null}
      {typeof detail?.revisedPrompt === "string" ? (
        <details className="mt-1 text-xs text-ink-3">
          <summary className="cursor-pointer">Image prompt</summary>
          <p className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words">{detail.revisedPrompt}</p>
        </details>
      ) : null}
    </section>
  );
}
