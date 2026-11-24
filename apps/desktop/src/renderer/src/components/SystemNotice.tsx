import { useLayoutEffect, useRef, useState } from "react";
import { noticeFrom, type NoticeFrom } from "@openorc/client";
import { cn } from "../lib/cn";
import { openThread } from "../lib/router";
import { WorkMessage } from "./icons";
import { ThreadRichText } from "./ThreadImages";
import { TextButton } from "./ui";

/**
 * Words in the thread that are not the user's and not the agent's. Another thread's or an Orcling's read as a message:
 * who it is from, then what it said. OpenOrc's own (a task result, a hand-off) read by their first line, the rest on demand.
 */
export function SystemNotice({ text }: { text: string }) {
  const from = noticeFrom(text);
  return (
    <div className="system-notice">
      <WorkMessage size={16} className="system-notice-icon" />
      <div className="min-w-0 flex-1">{from ? <Received from={from} /> : <Told text={text} />}</div>
    </div>
  );
}

function Told({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const [head, ...rest] = text.split("\n");
  const details = rest.join("\n").trim();
  return (
    <>
      <div className="text-ink-2">{head}</div>
      {details ? (
        <>
          {open ? <pre className="system-notice-details">{details}</pre> : null}
          <TextButton tone="faint" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="mt-1 text-sm">
            {open ? "Hide details" : "Show details"}
          </TextButton>
        </>
      ) : null}
    </>
  );
}

/** How much of a message shows before it folds, and the least a fold may hide: under that, the whole message shows. */
const FOLD = { height: 132, least: 44 };

function Received({ from }: { from: NoticeFrom }) {
  const words = useRef<HTMLDivElement>(null);
  const [tall, setTall] = useState(false);
  const [all, setAll] = useState(false);
  useLayoutEffect(() => {
    const el = words.current;
    if (!el) return;
    const measure = () => setTall(el.scrollHeight > FOLD.height + FOLD.least);
    measure();
    const resized = new ResizeObserver(measure);
    resized.observe(el);
    return () => resized.disconnect();
  }, []);
  return (
    <>
      <div className="system-notice-from">
        {from.lead} <Sender name={from.name} threadId={from.threadId} />
      </div>
      <div ref={words} className={cn("system-notice-words prose-chat", tall && !all && "system-notice-folded")}>
        <ThreadRichText>{from.text}</ThreadRichText>
      </div>
      {tall ? (
        <TextButton tone="faint" aria-expanded={all} onClick={() => setAll((v) => !v)} className="mt-1.5 text-sm">
          {all ? "Show less" : "Show all"}
        </TextButton>
      ) : null}
    </>
  );
}

/** Who wrote it. A thread's name opens that thread; an Orcling's chat is not a thread to open. */
function Sender({ name, threadId }: { name: string; threadId: string | null }) {
  if (!threadId) return <span className="system-notice-name">{name}</span>;
  return (
    <button type="button" className="system-notice-name" data-tip="Open thread" onClick={() => openThread(threadId)}>
      {name}
    </button>
  );
}
