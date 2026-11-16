import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Terminal as Xterm } from "@xterm/xterm";
import { RotateCcw, Square, Terminal } from "../components/icons";
import { Button, Empty, IconButton, TextButton } from "../components/ui";
import { PanelBar, PanelBarMeta, PanelNotice } from "../components/PanelBar";
import { typeAtPrompt } from "../lib/terminal-requests";
import { useTheme } from "../lib/theme";
import { terminalTheme } from "./terminal-theme";
import { followTerminalFont } from "./terminal-font";
import { isDark, openXterm } from "./xterm";
import "@xterm/xterm/css/xterm.css";

/**
 * A shell in the workspace the Changes tab reads. The process lives in main
 * and outlives this component on purpose: unmounting stops watching it, and
 * only Stop ends it, so switching tabs mid-build loses nothing.
 */

/**
 * The panel slides over 220ms and the observer reports every frame of it. A
 * trailing wait longer than one frame collapses the whole slide into a single
 * resize, which is all the shell wants: the sizes in between belong to an
 * animation, and redrawing for each of them is work for nobody.
 */
const RESIZE_SETTLE_MS = 150;

type Status = { kind: "starting" } | { kind: "running" } | { kind: "exited"; code: number | null } | { kind: "error"; message: string };

/** The words of a terminal's End and Restart: a shell on this Mac, or a cloud thread's terminal. */
export type TerminalBarWords = { end: string; endTip: string; restart: string; restartTip: string };
const SHELL_WORDS: TerminalBarWords = { end: "End shell", endTip: "End this shell and forget its output", restart: "Restart shell", restartTip: "Start a new shell here" };

/** The tool's bar: where the shell runs, then End and, where the reader may start one, Restart. */
export function TerminalBar({
  meta,
  running,
  onStop,
  onRestart,
  words = SHELL_WORDS,
}: {
  meta: ReactNode;
  running: boolean;
  onStop: () => void;
  onRestart: (() => void) | null;
  words?: TerminalBarWords;
}) {
  return (
    <PanelBar title="Terminal" meta={meta}>
      <IconButton onClick={onStop} aria-label={words.end} disabled={!running} data-tip={words.endTip}>
        <Square size={14} />
      </IconButton>
      {onRestart ? (
        <IconButton onClick={onRestart} aria-label={words.restart} data-tip={words.restartTip}>
          <RotateCcw size={14} />
        </IconButton>
      ) : null}
    </PanelBar>
  );
}

/** Where a shell on this Mac runs, its folder's tail, the whole path on hover. */
function ShellPath({ cwd }: { cwd: string }) {
  return (
    <PanelBarMeta className="font-mono" title={cwd}>
      {shortPath(cwd)}
    </PanelBarMeta>
  );
}

/** The panel is 440px wide by default; the tail of a worktree path is the part that says which workspace this is. */
function shortPath(cwd: string): string {
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  return parts.length <= 2 ? cwd : `…/${parts.slice(-2).join("/")}`;
}

export function TerminalPanel({ id, cwd }: { id: string; cwd: string }) {
  const resolved = useTheme((s) => s.resolved);
  const preset = useTheme((s) => s.preset);
  const custom = useTheme((s) => s.custom);
  const [status, setStatus] = useState<Status>({ kind: "starting" });
  const [generation, setGeneration] = useState(0);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Xterm | null>(null);

  useEffect(() => {
    const element = hostRef.current;
    if (!element) return;
    const api = window.openorc.terminal;
    const { term, fit } = openXterm(element);
    termRef.current = term;

    const keys = term.onData((data: string) => api.write(id, data));
    let settle = 0;
    const resize = (): void => {
      fit.fit();
      api.resize(id, term.cols, term.rows);
    };
    const observer = new ResizeObserver(() => {
      window.clearTimeout(settle);
      settle = window.setTimeout(resize, RESIZE_SETTLE_MS);
    });
    observer.observe(element);
    const stopFont = followTerminalFont(term, resize);

    let live = true;
    let offData = (): void => {};
    let offExit = (): void => {};
    // Commands asked for elsewhere, such as signing in.
    const requests = typeAtPrompt(id, (command) => api.write(id, `${command}\r`));
    // Before the open, not after: main sends nothing for a shell nobody is
    // watching, so anything written during the round trip would be held back
    // rather than queued. Attached first, those bytes are in the snapshot the
    // open takes, and the stream picks up from there with no gap.
    api.attach(id);
    void (async () => {
      try {
        const { backlog, running, exitCode } = await api.open({ id, cwd, cols: term.cols, rows: term.rows });
        if (!live) return;
        if (backlog) term.write(backlog);
        // Subscribing here rather than before the call is what keeps the replay
        // and the live stream from overlapping: main stops batching at the
        // moment it takes the snapshot, so the first push it sends afterwards
        // cannot arrive before this line has run.
        offData = api.onData(id, (chunk) => {
          term.write(chunk);
          requests.output(chunk);
        });
        offExit = api.onExit(id, (code) => {
          requests.ended();
          setStatus({ kind: "exited", code });
        });
        // A shell that ended while this panel was away said so to nobody, so
        // its code comes back with the backlog instead of over the wire.
        setStatus(running ? { kind: "running" } : { kind: "exited", code: exitCode });
        if (running && backlog) requests.output(backlog);
      } catch (error) {
        if (live) setStatus({ kind: "error", message: error instanceof Error ? error.message : String(error) });
      }
    })();

    return () => {
      live = false;
      window.clearTimeout(settle);
      observer.disconnect();
      stopFont();
      requests.dispose();
      offData();
      offExit();
      keys.dispose();
      // The shell is deliberately left running. Closing the panel puts the view
      // away; ending the process is something the reader asks for. Detaching is
      // how main hears that: without it, a `yes` in a tab nobody is looking at
      // keeps posting to this window for the life of the app.
      api.detach(id);
      term.dispose();
      termRef.current = null;
    };
  }, [id, cwd, generation]);

  // The store already re-resolves on a system change and on another window's
  // edit, so watching it is the whole subscription. DiffView listens to the
  // media query as well because it tracks the choice rather than the result.
  useEffect(() => {
    const term = termRef.current;
    if (term) term.options.theme = terminalTheme(getComputedStyle(term.element ?? document.documentElement), isDark());
  }, [resolved, preset, custom]);

  const restart = (): void => {
    window.openorc.terminal.kill(id);
    setStatus({ kind: "starting" });
    setGeneration((n) => n + 1);
  };
  const stop = (): void => {
    window.openorc.terminal.kill(id);
    setStatus({ kind: "exited", code: null });
  };

  return (
    <div className="h-full flex flex-col min-h-0">
      <TerminalBar meta={<ShellPath cwd={cwd} />} running={status.kind === "running"} onStop={stop} onRestart={restart} />
      {status.kind === "exited" ? (
        <PanelNotice>
          The shell ended{status.code === null ? "" : ` with code ${status.code}`}.{" "}
          <TextButton type="button" underline onClick={restart}>
            Start a new one
          </TextButton>
        </PanelNotice>
      ) : null}
      <div className="relative flex-1 min-h-0">
        {/* The host stays mounted through every state: xterm measures it to lay out, and it still holds the output of a shell that has ended. */}
        <div ref={hostRef} className="absolute inset-0 pl-5 pr-2.5 pb-2.5" />
        {status.kind === "error" ? (
          <div className="absolute inset-0 bg-bg">
            <Empty
              title="Could not open a shell"
              icon={<Terminal size={20} />}
              action={
                <Button size="sm" onClick={restart}>
                  <RotateCcw size={12} /> Try again
                </Button>
              }
            >
              {status.message}
            </Empty>
          </div>
        ) : null}
      </div>
    </div>
  );
}
