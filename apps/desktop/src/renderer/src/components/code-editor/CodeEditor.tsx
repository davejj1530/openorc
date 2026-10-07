import { useLayoutEffect, useRef } from "react";
import { isolateHistory } from "@codemirror/commands";
import { Annotation } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { bindCaller, createState, loadLanguage, setReadOnly } from "./extensions";
import { replacement } from "./replacement";
import { findSession, isKept, keepSession, type EditorSession } from "./sessions";
import type { CodeEditorProps, LineRange } from "./types";

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
  if (session.scroll) view.dispatch({ effects: session.scroll });
  loadLanguage(view, initial.path, () => alive);
  const unmount = () => {
    alive = false;
    session.state = view.state;
    session.scroll = view.scrollSnapshot();
    if (isKept(key, session)) keepSession(key, session);
    view.destroy();
  };
  return { mounted: { view, session }, unmount };
}

function revealLines(view: EditorView, { start, end }: LineRange): void {
  const doc = view.state.doc;
  const first = doc.line(Math.min(Math.max(1, start), doc.lines));
  const last = doc.line(Math.min(Math.max(first.number, end), doc.lines));
  view.dispatch({ selection: { anchor: first.from, head: last.to }, effects: EditorView.scrollIntoView(first.from, { y: "center" }) });
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
    revealLines(mounted.view, reveal);
  }, [sessionKey, reveal]);

  useLayoutEffect(() => {
    if (focusRequest) editor.current?.view.focus();
  }, [sessionKey, focusRequest]);

  return <div ref={host} className="h-full min-h-0" />;
}
