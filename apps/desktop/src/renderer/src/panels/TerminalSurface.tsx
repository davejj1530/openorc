import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { ContextMenu } from "@base-ui/react/context-menu";
import { ArrowDown, ArrowUp, X } from "../components/icons";
import { menuItem, menuPopup, menuSeparator } from "../components/menu";
import { IconButton, Input } from "../components/ui";
import { CoversPreview } from "../lib/browser-preview";
import { floatingGround } from "../lib/use-anchor-ground";
import { terminalKey } from "./terminal-keys";
import { openTerminalLink, type TerminalScreen } from "./terminal-screen";
import { findMarks } from "./terminal-theme";

/**
 * Where a terminal's screen is drawn, with what a reader does to one besides typing: the clipboard, a find, and a menu
 * on a right click. The host stays mounted through every state of its shell: xterm measures it to lay out, and it still
 * holds the output of a shell that has ended. `children` cover it.
 */
export function TerminalSurface({ hostRef, screen, children }: { hostRef: RefObject<HTMLDivElement | null>; screen: TerminalScreen | null; children?: ReactNode }) {
  const [finding, setFinding] = useState(false);
  const findField = useRef<HTMLInputElement | null>(null);

  const copy = (): void => {
    if (screen?.term.hasSelection()) void navigator.clipboard.writeText(screen.term.getSelection());
  };
  // xterm wraps a paste in the brackets a shell asked for, so pasted lines are not run one by one.
  const paste = (): void => {
    void navigator.clipboard.readText().then(
      (text) => {
        if (text) screen?.term.paste(text);
      },
      () => undefined,
    );
  };
  const find = (): void => {
    setFinding(true);
    findField.current?.focus();
    findField.current?.select();
  };

  // Heard on the way down, before xterm turns the press into bytes for the shell.
  const onKey = (event: KeyboardEvent): void => {
    if (!screen || !(event.target instanceof Node) || !screen.term.element?.contains(event.target)) return;
    const key = terminalKey(event, window.openorc.platform, screen.term.hasSelection());
    if (!key) return;
    event.preventDefault();
    event.stopPropagation();
    if (key.kind === "copy") {
      copy();
      if (key.thenClear) screen.term.clearSelection();
    } else if (key.kind === "paste") paste();
    else if (key.kind === "find") find();
    else screen.term.input(key.data);
  };

  return (
    <div className="relative flex-1 min-h-0" onKeyDownCapture={onKey}>
      <TerminalMenu hostRef={hostRef} screen={screen} findField={findField} onCopy={copy} onPaste={paste} onFind={find} />
      {finding && screen ? (
        <TerminalFind
          screen={screen}
          fieldRef={findField}
          onClose={() => {
            setFinding(false);
            screen.term.focus();
          }}
        />
      ) : null}
      {children}
    </div>
  );
}

/** What a right click landed on, read once as the menu opens so its rows do not change under the pointer. */
type Clicked = { selected: boolean; typing: boolean; link: string | null };

/** The screen's host and the menu a right click on it opens. A closing menu hands the focus back to the terminal, or to the find it opened. */
function TerminalMenu({
  hostRef,
  screen,
  findField,
  onCopy,
  onPaste,
  onFind,
}: {
  hostRef: RefObject<HTMLDivElement | null>;
  screen: TerminalScreen | null;
  findField: RefObject<HTMLInputElement | null>;
  onCopy: () => void;
  onPaste: () => void;
  onFind: () => void;
}) {
  const [clicked, setClicked] = useState<Clicked>({ selected: false, typing: false, link: null });
  const pickedFind = useRef(false);
  const { link } = clicked;
  return (
    <ContextMenu.Root
      onOpenChange={(open) => {
        if (!open) return;
        pickedFind.current = false;
        if (screen) setClicked({ selected: screen.term.hasSelection(), typing: !screen.term.options.disableStdin, link: screen.link() });
      }}
    >
      <ContextMenu.Trigger ref={hostRef} className="absolute inset-0 pl-5 pr-2.5 pb-2.5" />
      <ContextMenu.Portal>
        <CoversPreview />
        <ContextMenu.Positioner collisionPadding={8} className="z-40">
          <ContextMenu.Popup ref={floatingGround} className={menuPopup} finalFocus={() => (pickedFind.current ? findField.current : screen?.term.textarea) ?? true}>
            {link ? (
              <>
                <ContextMenu.Item className={menuItem} onClick={() => openTerminalLink(link)}>
                  Open link
                </ContextMenu.Item>
                <ContextMenu.Item className={menuItem} onClick={() => void navigator.clipboard.writeText(link)}>
                  Copy link
                </ContextMenu.Item>
                <ContextMenu.Separator className={menuSeparator} />
              </>
            ) : null}
            <ContextMenu.Item className={menuItem} disabled={!clicked.selected} onClick={onCopy}>
              Copy
            </ContextMenu.Item>
            <ContextMenu.Item className={menuItem} disabled={!clicked.typing} onClick={onPaste}>
              Paste
            </ContextMenu.Item>
            <ContextMenu.Item className={menuItem} onClick={() => screen?.term.selectAll()}>
              Select all
            </ContextMenu.Item>
            <ContextMenu.Separator className={menuSeparator} />
            <ContextMenu.Item
              className={menuItem}
              onClick={() => {
                pickedFind.current = true;
                onFind();
              }}
            >
              Find
            </ContextMenu.Item>
          </ContextMenu.Popup>
        </ContextMenu.Positioner>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

/** Where a find stands among what it found. */
type Count = { at: number; of: number };

/**
 * A find over everything the screen holds. A terminal's news is at its end, so it looks upward from there: Enter goes
 * to the match before, Shift+Enter to the one after.
 */
function TerminalFind({ screen, fieldRef, onClose }: { screen: TerminalScreen; fieldRef: RefObject<HTMLInputElement | null>; onClose: () => void }) {
  const [text, setText] = useState("");
  const [count, setCount] = useState<Count | null>(null);
  const { term, search } = screen;

  useEffect(() => {
    const heard = search.onDidChangeResults(({ resultIndex, resultCount }) => setCount({ at: resultIndex, of: resultCount }));
    return () => {
      heard.dispose();
      search.clearDecorations();
    };
  }, [search]);

  const look = (words: string, direction: "before" | "after" | "here"): void => {
    if (!words) {
      search.clearDecorations();
      term.clearSelection();
      return setCount(null);
    }
    const decorations = findMarks(term.options.theme ?? {});
    if (direction === "after") search.findNext(words, { decorations });
    else search.findPrevious(words, { decorations, incremental: direction === "here" });
  };

  return (
    <div ref={floatingGround} role="search" className="floating-popover absolute top-1 right-4 z-10 flex items-center gap-0.5 rounded-lg p-1">
      <Input
        ref={fieldRef}
        autoFocus
        value={text}
        aria-label="Find in terminal"
        placeholder="Find"
        spellCheck={false}
        className="h-7 w-44 bg-transparent px-2 focus:bg-transparent"
        onChange={(event) => {
          setText(event.target.value);
          look(event.target.value, "here");
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose();
          else if (event.key === "Enter") look(text, event.shiftKey ? "after" : "before");
          else return;
          event.preventDefault();
        }}
      />
      {text ? <span className="shrink-0 px-1 text-sm text-ink-3 tabular whitespace-nowrap">{countWords(count)}</span> : null}
      <IconButton size="sm" aria-label="Previous match" disabled={!count?.of} onClick={() => look(text, "before")}>
        <ArrowUp size={14} />
      </IconButton>
      <IconButton size="sm" aria-label="Next match" disabled={!count?.of} onClick={() => look(text, "after")}>
        <ArrowDown size={14} />
      </IconButton>
      <IconButton size="sm" aria-label="Close find" onClick={onClose}>
        <X size={14} />
      </IconButton>
    </div>
  );
}

/** "3 of 12", or the count alone past the number of matches a find keeps its place among. */
function countWords(count: Count | null): string {
  if (!count?.of) return "No matches";
  return count.at < 0 ? `${count.of}` : `${count.at + 1} of ${count.of}`;
}
