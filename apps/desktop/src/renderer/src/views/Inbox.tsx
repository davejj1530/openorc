import { CircleHelp, Eye, MessageSquare, ShieldQuestion } from "../components/icons";
import type { InboxItem } from "@openorc/protocol";
import { TopBar } from "../components/TopBar";
import { Empty, metaSlot } from "../components/ui";
import { useRpc } from "../lib/query";
import { openTask, openThread } from "../lib/router";
import { relativeTime } from "../lib/time";
import { cn } from "../lib/cn";
import type { ReactNode } from "react";
import "./Inbox.css";

/** Everything that needs a human, most urgent first: approvals, proposed tasks, then finished runs to review. */
export function Inbox() {
  const inbox = useRpc("inbox.list", {}, { refetchInterval: 15_000 });
  const items = inbox.data?.items ?? [];
  let content: ReactNode = null;
  if (!inbox.isLoading && items.length === 0) content = <Empty title="Inbox zero">Approvals, proposed tasks, and finished runs will show up here.</Empty>;
  else if (!inbox.isLoading)
    content = (
      <div className="flex-1 overflow-y-auto">
        <div className="inbox-list">
          {items.map((item) => (
            <Row key={keyOf(item)} item={item} />
          ))}
        </div>
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
  let Icon = Eye;
  if (item.reason === "approval") Icon = ShieldQuestion;
  else if (item.reason === "proposed") Icon = CircleHelp;
  return (
    <button onClick={open} className="inbox-row">
      <Icon size={16} className="shrink-0 text-ink-3" />
      <span className="flex flex-1 min-w-0 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-1.5 text-ink">
          {item.kind === "thread" ? <MessageSquare size={12} className="shrink-0 text-ink-4" /> : null}
          <span className="truncate">{title}</span>
        </span>
        <span className="truncate text-sm text-ink-4">{item.detail}</span>
      </span>
      <span className={cn(metaSlot, "text-sm")}>{relativeTime(updatedAt)}</span>
    </button>
  );
}
