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
import { TerminalBar } from "./TerminalPanel";
import { isDark, openXterm } from "./xterm";
import { terminalTheme } from "./terminal-theme";
import { claimTerminal, terminalFor } from "./cloud-terminal-claims";

/** A view slides over 220ms; the shell is told the size it settles at, as on this Mac (TerminalPanel). */
const RESIZE_SETTLE_MS = 150;

const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;

type Ids = { threadId: string; terminalId: string };

/**
 * Which terminal of a cloud thread this tab shows (cloud-terminal-claims.ts). A tab with none opens one for a reader
 * who may: opening a Terminal tab is asking for a shell, as on this Mac, so a second tab is a second terminal.
 */
function useCloudTerminal(threadId: string, slot: string) {
  const params = { threadId };
  const list = useRpc("hosted.terminal.list", params, { staleTime: 0 });
  const open = useRpcMutation("hosted.terminal.open");
  const end = useRpcMutation("hosted.terminal.end");
  const [, setClaimed] = useState(0);
  const asked = useRef(false);
  const data = list.data;
  const shown = data ? terminalFor(threadId, slot, data.terminals) : null;
  const claim = (terminalId: string) => {
    claimTerminal(threadId, slot, terminalId);
    setClaimed((n) => n + 1);
  };
  // The tab keeps the terminal it shows, so it finds it again, and other tabs leave it to it.
  const shownId = shown?.id;
  useEffect(() => {
    if (shownId) claimTerminal(threadId, slot, shownId);
  }, [threadId, slot, shownId]);
  const reread = () => void queryClient.invalidateQueries({ queryKey: ["hosted.terminal.list", params] });
  const start = async () => {
    const opened = await open.mutateAsync({ threadId, cols: 100, rows: 24 }).catch(() => null);
    if (!opened) return;
    claim(opened.id);
    reread();
  };
  useEffect(() => {
    if (!data || asked.current || shown || !data.canOpen) return;
    asked.current = true;
    void start();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on the first read
  }, [data]);
  const mine = Boolean(shown && data && shown.openedBy.id === data.viewer);
  // One's own running terminal restarts even with the most open: it is ended, and its end waited for, before the next opens.
  const running = Boolean(shown && mine && shown.state !== "ended");
  const restart =
    data?.canOpen || running
      ? async () => {
          if (shown && running) {
            await end.mutateAsync({ threadId, terminalId: shown.id }).catch(() => undefined);
            await endedSoon(threadId, shown.id);
          }
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
export function CloudTerminalPanel({ threadId, slot = "main" }: { threadId: string; slot?: string }) {
  const { data, shown, mine, restart, stop, reread, failure, retry } = useCloudTerminal(threadId, slot);
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

/** Waits a little for the server to say a terminal has ended, as its host ends it after the ask. */
async function endedSoon(threadId: string, terminalId: string): Promise<void> {
  for (let tries = 0; tries < 30; tries++) {
    const read = await core.call("hosted.terminal.list", { threadId }).catch(() => null);
    if (!read || read.terminals.find((each) => each.id === terminalId)?.state === "ended") return;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
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

  // Ended: the screen keeps what it said, with no cursor and nothing to type into.
  useEffect(() => {
    const term = termRef.current;
    if (!term || terminal.state !== "ended") return;
    Object.assign(term.options, { disableStdin: true, cursorInactiveStyle: "none", cursorBlink: false });
    term.blur();
  }, [terminal.state]);

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

/**
 * Where each terminal's typing stands as this window last heard it, and the keystrokes still on their way. Kept past a
 * view: the terminal's record is read only when the terminal changes, never as typing grows, and the server takes a
 * keystroke from the offset it is sent at, skipping what it already has, so a view made again (after Changes, say)
 * types on from here, after what the last view sent, never from the record's stale offset.
 */
const typing = new Map<string, { at: number; sending: Promise<void> }>();

/** Sends the opener's keystrokes in order, each from where the terminal's typing stands, once more on a failure. */
function typeInto(term: Xterm, ids: Ids, typed: number): () => void {
  const kept = typing.get(ids.terminalId) ?? { at: typed, sending: Promise.resolve() };
  // Typed somewhere else since (the opener's phone): its record is ahead.
  kept.at = Math.max(kept.at, typed);
  typing.set(ids.terminalId, kept);
  const keys = term.onData((data: string) => {
    kept.sending = kept.sending.then(async () => {
      const send = () => core.call("hosted.terminal.input", { ...ids, at: kept.at, data });
      const answer = await send().catch(() => send().catch(() => null));
      if (answer) kept.at = Math.max(kept.at, answer.at);
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
