import { useLayoutEffect, useRef } from "react";
import { isolateHistory } from "@codemirror/commands";
import { Annotation, type StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { bindCaller, createState, loadLanguage, setReadOnly } from "./extensions";
import { replacement } from "./replacement";
import { findSession, isKept, keepSession, type EditorSession } from "./sessions";
import type { CodeEditorProps, LineRange } from "./types";
import { bindIntelligence, refreshIntelligence, releaseIntelligence } from "./intelligence";

/** Marks the change a new `text` prop made. The caller already has that text, so it isn't reported back. */
const fromCaller = Annotation.define<boolean>();

interface Mounted {
  view: EditorView;
  session: EditorSession;
}

function mount(parent: HTMLElement, key: string, props: () => CodeEditorProps): { mounted: Mounted; unmount: () => void } {
  const initial = props();
  const session = findSession(key) ?? { state: createState(initial.text, initial.path, initial.readOnly), scroll: null, reported: initial.text, revealed: null };
  keepSession(key, session);
  let alive = true;
  const view = new EditorView({
    state: session.state,
    parent,
    dispatchTransactions: (transactions, editor) => {
      editor.update(transactions);
      if (!transactions.some((transaction) => transaction.docChanged && !transaction.annotation(fromCaller))) return;
      session.reported = editor.state.sliceDoc();
      props().onChange(session.reported);
    },
  });
  bindCaller(view, props);
  const actions = bindIntelligence(view, () => props().intelligence);
  initial.onReady?.(actions);
  if (session.scroll) view.dispatch({ effects: session.scroll });
  // Read on scroll, not on unmount: an editor removed before it drew would report the top and lose its pending scroll.
  view.scrollDOM.addEventListener("scroll", () => (session.scroll = view.scrollSnapshot()), { passive: true });
  loadLanguage(view, initial.path, () => alive);
  const unmount = () => {
    alive = false;
    releaseIntelligence(view);
    props().onReady?.(null);
    session.state = view.state;
    if (isKept(key, session)) keepSession(key, session);
    view.destroy();
  };
  return { mounted: { view, session }, unmount };
}

/** Selects the lines and returns the scroll that centers them. */
function revealLines(view: EditorView, { start, end, column, endColumn }: LineRange): StateEffect<unknown> {
  const doc = view.state.doc;
  const first = doc.line(Math.min(Math.max(1, start), doc.lines));
  const last = doc.line(Math.min(Math.max(first.number, end), doc.lines));
  const scroll = EditorView.scrollIntoView(first.from, { y: "center" });
  const anchor = column ? Math.min(first.to, first.from + column - 1) : first.from;
  const head = endColumn ? Math.min(last.to, last.from + endColumn - 1) : last.to;
  view.dispatch({ selection: { anchor, head }, effects: scroll });
  return scroll;
}

/**
 * CodeMirror 6 behind the contract in types.ts. Keys it handles prevent their event's default, so App's shortcuts
 * and the panel's Escape leave them alone: Cmd+S saves, Shift+Option+F formats, Cmd+F opens the find panel, Cmd+[
 * and Cmd+] indent. Edit menu Undo arrives as a history `beforeinput` event, which CodeMirror's history handles.
 */
export function CodeEditor(props: CodeEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const latest = useRef(props);
  const editor = useRef<Mounted | null>(null);
  const { sessionKey, text, readOnly, reveal, focusRequest } = props;

  useLayoutEffect(() => {
    latest.current = props;
  });

  useLayoutEffect(() => {
    const { mounted, unmount } = mount(host.current!, sessionKey, () => latest.current);
    editor.current = mounted;
    return () => {
      editor.current = null;
      unmount();
    };
  }, [sessionKey]);

  useLayoutEffect(() => {
    const mounted = editor.current;
    if (!mounted || text === mounted.session.reported) return;
    const change = replacement(mounted.view.state, text);
    mounted.session.reported = text;
    if (change) mounted.view.dispatch({ changes: change, annotations: [fromCaller.of(true), isolateHistory.of("full")] });
  }, [sessionKey, text]);

  useLayoutEffect(() => {
    if (editor.current) setReadOnly(editor.current.view, readOnly);
  }, [sessionKey, readOnly]);

  useLayoutEffect(() => {
    const mounted = editor.current;
    if (!mounted || !reveal || reveal === mounted.session.revealed) return;
    mounted.session.revealed = reveal;
    mounted.session.scroll = revealLines(mounted.view, reveal);
    if (reveal.column !== undefined) mounted.view.focus();
  }, [sessionKey, reveal]);

  useLayoutEffect(() => {
    if (focusRequest) editor.current?.view.focus();
  }, [sessionKey, focusRequest]);

  useLayoutEffect(() => {
    if (editor.current) refreshIntelligence(editor.current.view);
  }, [sessionKey, props.analysisKey]);

  return <div ref={host} className="h-full min-h-0" />;
}
