import { memo, useMemo, useState } from "react";
import { toolResult, toolResultDetails } from "../lib/tool-result";
import { ThreadImage, ThreadLink } from "./ThreadImages";

const textStyle = "px-3 py-2 whitespace-pre-wrap break-words text-ink-3 max-h-72 overflow-auto";

/** Shared by all tool rows, including restored conversations and team transcripts. */
export const ToolResult = memo(function ToolResult({ output }: { output: unknown }) {
  const result = useMemo(() => toolResult(output), [output]);
  return (
    <div className="min-w-0 border-t border-line">
      {result.media.length ? (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,12rem),1fr))] items-start gap-3 p-3">
          {result.media.map((item, index) =>
            item.kind === "image" ? (
              <div key={index} className="min-w-0 [&_button]:my-0 [&_button]:w-full [&_img]:h-44 [&_img]:w-full [&_img]:object-contain">
                {item.src ? <ThreadImage key={item.src} src={item.src} alt={item.label} /> : <p className="py-3 text-ink-3">Image preview unavailable · {item.label}</p>}
              </div>
            ) : (
              <div key={index} className="min-w-0 break-words py-2">
                {item.href ? (
                  <span className="text-accent-ink underline underline-offset-2">
                    <ThreadLink href={item.href}>{item.label}</ThreadLink>
                  </span>
                ) : (
                  <p className="text-ink-2">{item.label}</p>
                )}
                {item.uri !== item.label ? <p className="mt-1 text-ink-3">{item.uri}</p> : null}
                {item.text !== undefined ? <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words text-ink-3">{item.text}</pre> : null}
              </div>
            ),
          )}
        </div>
      ) : null}
      {result.text ? <ResultText text={result.text} hasMedia={result.media.length > 0} /> : null}
      {result.details ? <ResultData output={output} /> : null}
    </div>
  );
});

function ResultText({ text, hasMedia }: { text: string; hasMedia: boolean }) {
  if (!hasMedia) return <pre className={textStyle}>{text}</pre>;
  return (
    <details>
      <summary className="px-3 py-2 text-ink-3">Result text</summary>
      <pre className={textStyle}>{text}</pre>
    </details>
  );
}

function ResultData({ output }: { output: unknown }) {
  const [open, setOpen] = useState(false);
  const text = useMemo(() => (open ? toolResultDetails(output) : ""), [open, output]);
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="px-3 py-2 text-ink-3">Result data</summary>
      {open ? <pre className={textStyle}>{text}</pre> : null}
    </details>
  );
}
