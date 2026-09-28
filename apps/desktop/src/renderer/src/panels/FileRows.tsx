import { useState } from "react";
import type { FileChange } from "@openorc/protocol";
import { ChevronRight, MessageSquare } from "../components/icons";
import { cn } from "../lib/cn";

const statusTone: Record<FileChange["status"], string> = { added: "text-ok", untracked: "text-ok", modified: "text-ink-2", deleted: "text-bad", renamed: "text-warn" };
const statusLetter: Record<FileChange["status"], string> = { added: "A", untracked: "U", modified: "M", deleted: "D", renamed: "R" };

/** The changed files, one compact row each, collapsible so the diff gets the height. */
export function FileRows({ files, commented }: { files: FileChange[]; commented?: Set<string> }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="shrink-0 max-h-56 flex flex-col">
      <button onClick={() => setOpen((v) => !v)} className="h-7 shrink-0 flex items-center gap-1.5 px-2 text-sm text-ink-3 hover:text-ink">
        <ChevronRight size={12} className={cn("transition-transform", open && "rotate-90")} />
        {files.length} file{files.length === 1 ? "" : "s"}
      </button>
      {open ? (
        <div className="overflow-y-auto pb-1">
          {files.map((f) => (
            <div key={f.path} className="flex items-center gap-2 h-6 px-3 text-sm">
              <span className={cn("w-3 font-mono text-xs font-medium", statusTone[f.status])}>{statusLetter[f.status]}</span>
              <span className="font-mono truncate text-ink-2" title={f.path}>
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
