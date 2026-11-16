import { useEffect, useRef, useState } from "react";
import type { HostedTerminal } from "@openorc/protocol";
import type { Terminal as Xterm } from "@xterm/xterm";
import { Terminal } from "../components/icons";
import { PanelBarMeta, PanelNotice } from "../components/PanelBar";
import { Button, Empty, TextButton } from "../components/ui";
import { queryClient, useRpc, useRpcMutation } from "../lib/client";
import { core } from "../lib/rpc";
import { useTheme } from "../lib/theme";
import { followTerminalFont } from "./terminal-font";
import { isDark, openXterm, TerminalBar } from "./TerminalPanel";
import { terminalTheme } from "./terminal-theme";

/** A view slides over 220ms; the shell is told the size it settles at, as on this Mac (TerminalPanel). */
const RESIZE_SETTLE_MS = 150;

const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;

type Ids = { threadId: string; terminalId: string };

/**
 * Which terminal of a cloud thread the panel shows: the one it opened, else the newest open one, else the newest. A
 * thread with none opens one for a reader who may: opening the panel is asking for a shell, as on this Mac.
 */
function useCloudTerminal(threadId: string) {
  const params = { threadId };
  const list = useRpc("hosted.terminal.list", params, { staleTime: 0 });
  const open = useRpcMutation("hosted.terminal.open");
  const end = useRpcMutation("hosted.terminal.end");
  const [shownId, setShownId] = useState<string | null>(null);
  const asked = useRef(false);
  const data = list.data;
  const terminals = data?.terminals ?? [];
  const shown = terminals.find((each) => each.id === shownId) ?? terminals.find((each) => each.state !== "ended") ?? terminals[0] ?? null;
  const reread = () => void queryClient.invalidateQueries({ queryKey: ["hosted.terminal.list", params] });
  const start = async () => {
    const opened = await open.mutateAsync({ threadId, cols: 100, rows: 24 }).catch(() => null);
    if (!opened) return;
    setShownId(opened.id);
    reread();
  };
  useEffect(() => {
    if (!data || asked.current || data.terminals.length > 0 || !data.canOpen) return;
    asked.current = true;
    void start();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on the first read
  }, [data]);
  const mine = Boolean(shown && data && shown.openedBy.id === data.viewer);
  const restart = data?.canOpen
    ? async () => {
        if (shown && shown.state !== "ended" && mine) await end.mutateAsync({ threadId, terminalId: shown.id }).catch(() => undefined);
        await start();
      }
    : null;
  const stop = () => {
    if (shown) void end.mutateAsync({ threadId, terminalId: shown.id }).then(reread, () => undefined);
  };
  const failure = open.error ?? list.error;
  const retry = () => (open.error ? void start() : void list.refetch());
  return { data, shown, mine, restart, stop, reread, failure, retry };
}

/**
 * A cloud thread's terminal: a shell on the thread's machine. Its opener types in it; anyone else in the thread watches
 * it, with no cursor, and may end it. One that ended says only the server's reason for that end.
 */
export function CloudTerminalPanel({ threadId }: { threadId: string }) {
  const { data, shown, mine, restart, stop, reread, failure, retry } = useCloudTerminal(threadId);
  if (failure) return <TerminalEmpty title="Could not open a terminal" words={failure.message} onRetry={retry} />;
  if (!data) return null;
  if (!shown) return <TerminalEmpty title="No terminal here" words={data.reason ?? ""} onRetry={null} />;
  const owner = firstName(shown.openedBy.name);
  return (
    <div className="h-full flex flex-col min-h-0">
      <TerminalBar
        meta={<PanelBarMeta>{mine ? "OpenOrc Cloud" : `${owner}'s`}</PanelBarMeta>}
        running={shown.state !== "ended"}
        onStop={stop}
        onRestart={mine && restart ? () => void restart() : null}
        words={{ end: "End terminal", endTip: mine ? "End this terminal" : `End ${owner}'s terminal`, restart: "Restart terminal", restartTip: "Start a new terminal" }}
      />
      {shown.ended ? <EndedNotice message={shown.ended.message} onStart={restart && (() => void restart())} /> : null}
      <CloudTerminalView key={shown.id} threadId={threadId} terminal={shown} typing={mine} onChanged={reread} />
    </div>
  );
}

function TerminalEmpty({ title, words, onRetry }: { title: string; words: string; onRetry: (() => void) | null }) {
  return (
    <div className="h-full flex flex-col min-h-0">
      <Empty
        title={title}
        icon={<Terminal size={20} />}
        action={
          onRetry ? (
            <Button size="sm" onClick={onRetry}>
              Try again
            </Button>
          ) : undefined
        }
      >
        {words}
      </Empty>
    </div>
  );
}

/** The server's reason for this end and nothing beside it, then the way to a new one for a reader who may. */
function EndedNotice({ message, onStart }: { message: string; onStart: (() => void) | null }) {
  return (
    <PanelNotice>
      {message}
      {onStart ? (
        <>
          {" "}
          <TextButton type="button" underline onClick={onStart}>
            Start a new one
          </TextButton>
        </>
      ) : null}
    </PanelNotice>
  );
}

/** One terminal's screen: its output followed by offset, its opener's keystrokes and size sent on. */
function CloudTerminalView({ threadId, terminal, typing, onChanged }: { threadId: string; terminal: HostedTerminal; typing: boolean; onChanged: () => void }) {
  const resolved = useTheme((s) => s.resolved);
  const preset = useTheme((s) => s.preset);
  const custom = useTheme((s) => s.custom);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Xterm | null>(null);
  const open = terminal.state === "open";
  const openNow = useRef(open);
  openNow.current = open;

  useEffect(() => {
    const element = hostRef.current;
    if (!element) return;
    const { term, fit } = openXterm(element);
    termRef.current = term;
    if (!typing) Object.assign(term.options, { disableStdin: true, cursorInactiveStyle: "none", cursorBlink: false });
    const ids = { threadId, terminalId: terminal.id };
    const unfollow = followOutput(term, ids, onChanged);
    const keys = typing ? typeInto(term, ids, terminal.typed) : () => {};
    let settle = 0;
    const resize = (): void => {
      fit.fit();
      if (typing && openNow.current) void core.call("hosted.terminal.size", { ...ids, cols: term.cols, rows: term.rows }).catch(() => undefined);
    };
    const observer = new ResizeObserver(() => {
      window.clearTimeout(settle);
      settle = window.setTimeout(resize, RESIZE_SETTLE_MS);
    });
    observer.observe(element);
    const stopFont = followTerminalFont(term, resize);
    return () => {
      window.clearTimeout(settle);
      observer.disconnect();
      stopFont();
      unfollow();
      keys();
      term.dispose();
      termRef.current = null;
    };
    // The screen belongs to one terminal; its state changing does not start it again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId, terminal.id, typing]);

  // Open, or opened since the screen was made: the shell is told the view's size, and the opener types in it.
  useEffect(() => {
    const term = termRef.current;
    if (!term || !open || !typing) return;
    void core.call("hosted.terminal.size", { threadId, terminalId: terminal.id, cols: term.cols, rows: term.rows }).catch(() => undefined);
    term.focus();
  }, [open, typing, threadId, terminal.id]);

  useEffect(() => {
    const term = termRef.current;
    if (term) term.options.theme = terminalTheme(getComputedStyle(term.element ?? document.documentElement), isDark());
  }, [resolved, preset, custom]);

  return (
    <div className="relative flex-1 min-h-0">
      <div ref={hostRef} className="absolute inset-0 pl-5 pr-2.5 pb-2.5" />
    </div>
  );
}

/**
 * Writes a terminal's output into `term` from its first byte, then live: a frame already shown is skipped, one past a
 * gap reads the gap again, and what the server no longer keeps is passed over. Answers how to stop following.
 */
function followOutput(term: Xterm, ids: Ids, onChanged: () => void): () => void {
  let live = true;
  let have = 0;
  let reading: Promise<void> = Promise.resolve();
  const write = (at: number, bytes: Uint8Array) => {
    if (at > have) return void readFrom();
    const fresh = bytes.subarray(have - at);
    if (fresh.length === 0) return;
    term.write(fresh);
    have += fresh.length;
  };
  const readFrom = () => {
    reading = reading.then(async () => {
      if (!live) return;
      const read = await core.call("hosted.terminal.output", { ...ids, from: have }).catch(() => null);
      if (!read || !live) return;
      if (read.from > have) have = read.from;
      write(read.from, base64(read.data));
    });
  };
  const offPush = core.onHostedTerminal((push) => {
    if (push.terminalId !== ids.terminalId) return;
    const { event } = push;
    if (event.kind === "output") reading = reading.then(() => write(event.at, base64(event.data)));
    else if (event.kind === "gap") readFrom();
    else onChanged();
  });
  void core.call("hosted.terminal.watch", { ...ids, watch: true }).catch(() => undefined);
  readFrom();
  return () => {
    live = false;
    offPush();
    void core.call("hosted.terminal.watch", { ...ids, watch: false }).catch(() => undefined);
  };
}

/** Sends the opener's keystrokes in order, each from where the terminal's typing stands, once more on a failure. */
function typeInto(term: Xterm, ids: Ids, typed: number): () => void {
  let at = typed;
  let sending: Promise<void> = Promise.resolve();
  const keys = term.onData((data: string) => {
    sending = sending.then(async () => {
      const send = () => core.call("hosted.terminal.input", { ...ids, at, data });
      const answer = await send().catch(() => send().catch(() => null));
      if (answer) at = answer.at;
    });
  });
  return () => keys.dispose();
}

function base64(data: string): Uint8Array {
  const text = atob(data);
  const bytes = new Uint8Array(text.length);
  for (let at = 0; at < text.length; at++) bytes[at] = text.charCodeAt(at);
  return bytes;
}
