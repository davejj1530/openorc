import { CircleHelp, Eye, MessageSquare, ShieldQuestion } from "../components/icons";
import type { InboxItem } from "@openorc/protocol";
import { TopBar } from "../components/TopBar";
import { Empty, metaSlot } from "../components/ui";
import { cn } from "../lib/cn";
import { useRpc } from "../lib/query";
import { openTask, openThread } from "../lib/router";
import { relativeTime } from "../lib/time";
import type { ReactNode } from "react";

/** Everything that needs a human, most urgent first: approvals, proposed tasks, then finished runs to review. */
export function Inbox() {
  const inbox = useRpc("inbox.list", {}, { refetchInterval: 15_000 });
  const items = inbox.data?.items ?? [];
  let content: ReactNode = null;
  if (!inbox.isLoading && items.length === 0) content = <Empty title="Inbox zero">Approvals, proposed tasks, and finished runs will show up here.</Empty>;
  else if (!inbox.isLoading)
    content = (
      <div className="flex-1 overflow-y-auto rounded-lg">
        {items.map((item) => (
          <Row key={keyOf(item)} item={item} />
        ))}
      </div>
    );
  return (
    <>
      <TopBar>Inbox</TopBar>
      {content}
    </>
  );
}

function keyOf(item: InboxItem): string {
  return item.kind === "task" ? `${item.reason}-${item.task.id}-${item.runId ?? ""}` : `${item.reason}-${item.thread.id}-${item.runId}`;
}

function Row({ item }: { item: InboxItem }) {
  const title = item.kind === "task" ? item.task.title : item.thread.title;
  const updatedAt = item.kind === "task" ? item.task.updatedAt : item.thread.lastActivityAt;
  const open = () => {
    if (item.kind === "thread") openThread(item.thread.id);
    else openTask(item.task.id, item.reason === "review" ? "files" : "chat");
  };
  let icon: ReactNode = <Eye size={16} className="text-ink-3 shrink-0" />;
  if (item.reason === "approval") icon = <ShieldQuestion size={16} className="text-warn shrink-0" />;
  else if (item.reason === "proposed") icon = <CircleHelp size={16} className="text-warn shrink-0" />;
  return (
    <button onClick={open} className="w-full flex items-center gap-3 h-12 px-6 border-b border-line text-left hover:bg-surface-2">
      {icon}
      <div className="flex-1 min-w-0">
        <div className="text-base truncate flex items-center gap-2">
          {item.kind === "thread" ? <MessageSquare size={12} className="text-ink-4 shrink-0" /> : null}
          {title}
        </div>
        <div className={cn("text-sm text-ink-3 truncate", item.reason === "approval" && "font-mono")}>{item.detail}</div>
      </div>
      <span className={cn(metaSlot, "w-16 text-sm")}>{relativeTime(updatedAt)}</span>
    </button>
  );
}
