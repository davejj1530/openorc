import { memo, useMemo } from "react";
import { toolResult } from "@openorc/client";
import { ThreadImage, ThreadLink } from "./ThreadImages";

/** The pictures and files a call gave back. Its words and data are the raw call's to show. */
export const ToolResult = memo(function ToolResult({ output }: { output: unknown }) {
  const result = useMemo(() => toolResult(output), [output]);
  return (
    <div className="min-w-0 rounded-lg bg-surface-2">
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
    </div>
  );
});
