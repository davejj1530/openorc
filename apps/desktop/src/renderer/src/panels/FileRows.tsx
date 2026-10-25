import { useState } from "react";
import type { FileChange } from "@openorc/protocol";
import { fileCount, fileMarks, type FileMarkTone } from "@openorc/client";
import { ChevronRight, MessageSquare } from "../components/icons";
import { cn } from "../lib/cn";

const toneClass: Record<FileMarkTone, string> = { ok: "text-ok", "ink-2": "text-ink-2", bad: "text-bad", warn: "text-warn" };

/** The changed files, one compact row each, collapsible so the diff gets the height. */
export function FileRows({ files, commented }: { files: FileChange[]; commented?: Set<string> }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="shrink-0 max-h-56 flex flex-col">
      <button onClick={() => setOpen((v) => !v)} className="h-8 shrink-0 flex items-center gap-2 mx-2.5 px-2.5 rounded-md text-sm text-ink-3 hover:bg-surface-2 hover:text-ink">
        <ChevronRight size={14} className={cn("text-ink-4 transition-transform", open && "rotate-90")} />
        {fileCount(files.length)}
      </button>
      {open ? (
        <div className="overflow-y-auto pb-2">
          {files.map((f) => (
            <div key={f.path} className="flex items-center gap-2 h-7 px-5 text-sm">
              <span className={cn("w-3 font-mono text-xs", toneClass[fileMarks[f.status].tone])}>{fileMarks[f.status].letter}</span>
              <span className="font-mono truncate text-ink" title={f.path}>
                {f.path}
              </span>
              {commented?.has(f.path) ? <MessageSquare size={11} className="ml-auto text-ink-4 shrink-0" /> : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
