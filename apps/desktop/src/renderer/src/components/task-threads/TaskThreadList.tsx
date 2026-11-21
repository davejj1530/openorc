import { relativeTime, threadActivity } from "@openorc/client";
import type { TaskThreadLink } from "@openorc/protocol";
import { openThread } from "../../lib/router";
import { ArrowUpRight, MessageSquare } from "../icons";
import { WorkingCube } from "../OpenOrcMark";

/** A working thread has no label: the current one, else earlier work. A button's thread goes by the button's label. */
function role(link: TaskThreadLink): string {
  if (link.current) return "Current thread";
  return link.label ?? "Earlier thread";
}

export function TaskThreadList({ links }: { links: readonly TaskThreadLink[] }) {
  return links.map((link) => (
    <button key={link.thread.id} type="button" onClick={() => openThread(link.thread.id)} className="flex items-start gap-2 text-left text-sm text-ink-2 hover:text-ink mt-4 max-w-full">
      {link.thread.activity === "running" ? <WorkingCube className="mt-0.5 shrink-0" /> : <MessageSquare size={13} className="mt-0.5 shrink-0" />}
      <span className="min-w-0">
        <span className="block truncate">{link.thread.title}</span>
        <span className="block text-ink-3 mt-0.5">
          {[role(link), threadActivity(link.thread)?.text, relativeTime(link.thread.lastActivityAt ?? link.thread.updatedAt)].filter(Boolean).join(" · ")}
        </span>
      </span>
      <ArrowUpRight size={12} className="mt-0.5 shrink-0" />
    </button>
  ));
}
