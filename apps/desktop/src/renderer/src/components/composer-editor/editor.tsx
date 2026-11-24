import { createEmptyHistoryState, registerHistory, type HistoryState } from "@lexical/history";
import { registerPlainText } from "@lexical/plain-text";
import { $getRoot, createEditor, mergeRegister, type Klass, type LexicalEditor, type LexicalNode } from "lexical";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore, type HTMLAttributes, type ReactNode, type Ref } from "react";
import { createPortal } from "react-dom";

/**
 * The composer's editor in React: one Lexical editor per message box, the box it writes in, the marks it draws as
 * portals into their places, and its placeholder. Plain text editing and undo history are registered with it here, so
 * every plugin starts from a box that already types, pastes and undoes like a text field.
 */

const EditorContext = createContext<{ editor: LexicalEditor; history: HistoryState } | null>(null);

/** The editor of the message box this plugin sits in. */
export function useEditor(): LexicalEditor {
  return useEditorContext().editor;
}

function useEditorContext() {
  const context = useContext(EditorContext);
  if (!context) throw new Error("A composer plugin sits outside its editor.");
  return context;
}

/**
 * Starts the undo history over from the draft as it stands, as a text field's does when its value is set: nothing to
 * undo, and the next edit one step back to here. Clearing alone would leave no state for that next step to return to.
 */
export function useRestartHistory(): () => void {
  const { editor, history } = useEditorContext();
  return useCallback(() => {
    history.undoStack.length = 0;
    history.redoStack.length = 0;
    history.current = { editor, editorState: editor.getEditorState() };
  }, [editor, history]);
}

/** Every composer's editor on the page, for an Edit menu command to find the one being written in. */
const mounted = new Set<LexicalEditor>();

/** The composer editor that holds the page's focus, if any. */
export function focusedComposerEditor(): LexicalEditor | null {
  for (const editor of mounted) if (editor.getRootElement()?.contains(document.activeElement)) return editor;
  return null;
}

/** Typing within this long stays one step to undo. */
const UNDO_MERGE_MS = 1000;

export function EditorProvider({ namespace, nodes, children }: { namespace: string; nodes: readonly Klass<LexicalNode>[]; children: ReactNode }) {
  const [history] = useState(createEmptyHistoryState);
  const [editor] = useState(() =>
    createEditor({
      namespace,
      nodes: [...nodes],
      onError: (error) => {
        throw error;
      },
    }),
  );
  useEffect(() => {
    mounted.add(editor);
    return mergeRegister(registerPlainText(editor), registerHistory(editor, history, UNDO_MERGE_MS), () => mounted.delete(editor));
  }, [editor, history]);
  const context = useMemo(() => ({ editor, history }), [editor, history]);
  return <EditorContext.Provider value={context}>{children}</EditorContext.Provider>;
}

/** Whether the editor takes typing now, following its editable listener. */
export function useEditable(editor: LexicalEditor): boolean {
  const [subscribe, read] = useMemo(() => [(changed: () => void) => editor.registerEditableListener(changed), () => editor.isEditable()] as const, [editor]);
  return useSyncExternalStore(subscribe, read, read);
}

type BoxProps = Omit<HTMLAttributes<HTMLDivElement>, "contentEditable" | "role" | "children"> & { ref?: Ref<HTMLDivElement> | undefined };

/**
 * The element the words are typed in: a text box that keeps its name and role while it cannot be written in, reports
 * that as disabled, and drops the list it completes, which it cannot then use.
 */
export function EditorBox({ ref, ...props }: BoxProps) {
  const editor = useEditor();
  const editable = useEditable(editor);
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  // Set as the element mounts, before any plugin's layout effect writes the first draft into it.
  const attach = useCallback(
    (element: HTMLDivElement | null) => {
      editor.setRootElement(element);
      setRoot(element);
      if (typeof ref === "function") ref(element);
      else if (ref) ref.current = element;
    },
    [editor, ref],
  );
  return (
    <>
      <div
        {...props}
        ref={attach}
        role="textbox"
        contentEditable={editable}
        aria-disabled={editable ? undefined : true}
        aria-controls={editable ? props["aria-controls"] : undefined}
        aria-activedescendant={editable ? props["aria-activedescendant"] : undefined}
      />
      {root ? <Marks editor={editor} /> : null}
    </>
  );
}

/** Each mark node's drawing, rendered into the element the editor made for it. */
function Marks({ editor }: { editor: LexicalEditor }) {
  const [subscribe, read] = useMemo(() => [(changed: () => void) => editor.registerDecoratorListener(changed), () => editor.getDecorators<ReactNode>()] as const, [editor]);
  const decorators = useSyncExternalStore(subscribe, read, read);
  return Object.entries(decorators).map(([key, drawing]) => {
    const element = editor.getElementByKey(key);
    return element ? createPortal(drawing, element, key) : null;
  });
}

/** Shown while the message is empty and no input method is composing into it. */
export function EditorPlaceholder({ children }: { children: ReactNode }) {
  const editor = useEditor();
  const [subscribe, read] = useMemo(
    () =>
      [
        (changed: () => void) => mergeRegister(editor.registerUpdateListener(changed), editor.registerEditableListener(changed)),
        () => !editor.isComposing() && editor.getEditorState().read(() => $getRoot().getTextContent() === ""),
      ] as const,
    [editor],
  );
  return useSyncExternalStore(subscribe, read, read) ? <div aria-hidden="true">{children}</div> : null;
}
