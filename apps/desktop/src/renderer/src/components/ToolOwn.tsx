import { useState, type ReactNode } from "react";
import { fieldLabel, foldsWords, fromThread, memoryAge, memoryKind, oneLine, relativeTime, taskState, type MemoryRow, type OwnToolView, type TaskRow, type ThreadRow } from "@openorc/client";
import { openTask, openThread } from "../lib/router";
import { Globe } from "./icons";
import { WorkingCube } from "./OpenOrcMark";
import { ThreadLink, ThreadRichText } from "./ThreadImages";
import "./ToolOwn.css";

/** Rows a list shows before the rest wait behind a count. */
const ROWS = 4;
const THREADS = ["thread", "threads"] as const;
const MEMORIES = ["memory", "memories"] as const;
const TASKS = ["task", "tasks"] as const;

/**
 * One of OpenOrc's own tools, drawn as the thing it was about: threads as thread rows, a thread that was read as its
 * conversation, a message as what it said and where it landed, a page as its title with its picture, tasks and
 * memories as rows. `media`: the pictures the call gave back, for the views that show them.
 */
export function ToolOwn({ view, media }: { view: OwnToolView; media: ReactNode }) {
  switch (view.kind) {
    case "threads":
      return (
        <Rows items={view.threads} noun={THREADS} empty="No other threads">
          {(thread) => <ThreadLine key={thread.id} thread={thread} />}
        </Rows>
      );
    case "thread":
      return <Talk messages={view.messages} />;
    case "sent":
      return (
        <div className="own-sent">
          <div className="own-bubble">
            <Words text={view.text} />
          </div>
          {view.landed ? (
            <p className="own-quiet" data-tone={view.delivered ? undefined : "bad"}>
              {view.landed}
            </p>
          ) : null}
        </div>
      );
    case "page":
      return (
        <div className="own-page">
          <div className="own-page-head">
            <Globe size={13} />
            {view.title ? <span className="own-page-title">{view.title}</span> : null}
            <ThreadLink href={view.url}>{view.url.replace(/^https?:\/\//, "")}</ThreadLink>
          </div>
          {media}
          {view.text ? <Words text={view.text} plain /> : null}
        </div>
      );
    case "memories":
      return (
        <Rows items={view.hits} noun={MEMORIES} empty="Nothing in memory about this">
          {(hit, index) => <MemoryLine key={index} hit={hit} />}
        </Rows>
      );
    case "remembered":
      return (
        <div className="own-note">
          <p>{view.body}</p>
          {memoryKind(view.type) ? <p className="own-quiet">Kept as {memoryKind(view.type)}</p> : null}
        </div>
      );
    case "tasks":
      return (
        <Rows items={view.tasks} noun={TASKS} empty="No tasks">
          {(task) => <TaskLine key={task.id} task={task} />}
        </Rows>
      );
    case "task":
      return (
        <ul className="own-rows">
          <TaskLine task={view.task} />
        </ul>
      );
  }
}

/** A list as rows: the first few, then the rest behind a count. */
function Rows<T>({ items, noun, empty, children }: { items: T[]; noun: readonly [one: string, many: string]; empty: string; children: (item: T, index: number) => ReactNode }) {
  const [all, setAll] = useState(false);
  if (!items.length) return <p className="own-quiet">{empty}</p>;
  const shown = all ? items : items.slice(0, ROWS);
  const rest = items.length - shown.length;
  return (
    <>
      <ul className="own-rows">{shown.map(children)}</ul>
      {rest > 0 ? (
        <button type="button" className="work-more own-more" onClick={() => setAll(true)}>
          {rest} more {noun[rest === 1 ? 0 : 1]}
        </button>
      ) : null}
    </>
  );
}

/** A name in ink with a quiet word after it: a thread and its branch, a memory and its kind. */
function Title({ name, note }: { name: string; note: string | null }) {
  return (
    <span className="own-row-title">
      <span>{name}</span>
      {note ? <small>{note}</small> : null}
    </span>
  );
}

/** How long ago a thread last moved, when it says. */
const moved = (at: number | null) => (at === null ? "" : relativeTime(at));

/** A thread as the sidebar would show it, with the last thing its agent said. Pressing it opens the thread. */
function ThreadLine({ thread }: { thread: ThreadRow }) {
  const working = thread.activity !== "idle";
  const row = (
    <>
      <span className="own-row-mark">{working ? <WorkingCube /> : <span className="own-dot" role="img" aria-label="Idle" />}</span>
      <Title name={thread.title} note={thread.current ? "this thread" : thread.branch} />
      <span className="own-row-end">{thread.activity === "waiting" ? "Waiting" : moved(thread.lastActivityAt)}</span>
      {thread.lastReply ? <span className="own-row-last">{oneLine(thread.lastReply)}</span> : null}
    </>
  );
  // The thread the call was made from is the one already open.
  if (thread.current) return <li className="own-row">{row}</li>;
  return (
    <li>
      <button type="button" className="own-row" data-tip="Open thread" onClick={() => openThread(thread.id)}>
        {row}
      </button>
    </li>
  );
}

/** A task as its board would show it: where it stands, and the newest thing said of it. Pressing it opens the task. */
function TaskLine({ task }: { task: TaskRow }) {
  const working = task.state === "working";
  return (
    <li>
      <button type="button" className="own-row" data-tip="Open task" onClick={() => openTask(task.id)}>
        <span className="own-row-mark">{working ? <WorkingCube /> : <span className="own-dot" role="img" aria-label={task.status} />}</span>
        <Title name={task.title} note={task.current ? "this task" : fieldLabel(task.status).toLowerCase()} />
        <span className="own-row-end">{taskState(task.state)}</span>
        {task.latest ? <span className="own-row-last">{oneLine(task.latest)}</span> : null}
      </button>
    </li>
  );
}

function MemoryLine({ hit }: { hit: MemoryRow }) {
  return (
    <li className="own-row">
      <span className="own-row-mark" />
      <Title name={hit.title} note={memoryKind(hit.type)?.replace(/^an? /, "") ?? null} />
      <span className="own-row-end">{memoryAge(hit.ageDays)}</span>
      {hit.summary ? <span className="own-row-last">{hit.summary}</span> : null}
    </li>
  );
}

/** A thread's messages as a small conversation: the agent's words as prose, a person's as a bubble, a note from another thread behind a hairline. */
function Talk({ messages }: { messages: { role: string; text: string }[] }) {
  if (!messages.length) return <p className="own-quiet">No messages yet</p>;
  return (
    <div className="own-talk">
      {messages.map((message, index) => (
        <Said key={index} role={message.role} text={message.text} />
      ))}
    </div>
  );
}

function Said({ role, text }: { role: string; text: string }) {
  if (role === "user") return <div className="own-bubble own-you">{text}</div>;
  if (role !== "system") return <Words text={text} />;
  const from = fromThread(text);
  return (
    <div className="own-from">
      {from ? (
        <button type="button" className="own-from-name" data-tip="Open thread" onClick={() => openThread(from.id)}>
          From {from.title}
        </button>
      ) : null}
      <Words text={from?.text ?? text} plain />
    </div>
  );
}

/** Words that read in full when short, and by their first lines until asked for when long. `plain`: not the agent's own writing, so shown as written. */
function Words({ text, plain = false }: { text: string; plain?: boolean }) {
  const [all, setAll] = useState(false);
  if (foldsWords(text) && !all)
    return (
      <div className="own-words">
        <p className="own-fold">{oneLine(text)}</p>
        <button type="button" className="work-more" onClick={() => setAll(true)}>
          Show all
        </button>
      </div>
    );
  if (plain) return <p className="own-plain">{text}</p>;
  return (
    <div className="own-words prose-chat">
      <ThreadRichText codePaths>{text}</ThreadRichText>
    </div>
  );
}
