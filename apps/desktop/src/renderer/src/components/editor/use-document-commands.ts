import { useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import { matchingCommands } from "./commands";
import { slashQuery, type SlashMatch } from "./document-schema";

export type MenuState = SlashMatch & { left: number; top: number; above: boolean };

/** Owns slash-command selection and the listeners installed while its menu is open. */
export function useDocumentCommands(editor: Editor | null, source: boolean, pickImage: () => void) {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [highlight, setHighlight] = useState(0);
  const menuRef = useRef(menu);
  menuRef.current = menu;
  const highlighted = useRef(highlight);
  highlighted.current = highlight;
  const dismissed = useRef<string | null>(null);
  const pickImageRef = useRef(pickImage);
  pickImageRef.current = pickImage;

  const syncMenu = (currentEditor: Editor): void => {
    if (currentEditor.isDestroyed || source || !currentEditor.isEditable || currentEditor.view.composing) return;
    const { $from, empty, from } = currentEditor.state.selection;
    const query = empty && $from.parent.type.name === "paragraph" ? slashQuery($from.parent.textBetween(0, $from.parentOffset, undefined, "\ufffc"), $from.start(), from) : null;
    if (!query) {
      dismissed.current = null;
      setMenu(null);
      return;
    }
    if (dismissed.current === `${query.from}:${query.query}`) return;
    const rect = currentEditor.view.coordsAtPos(from);
    const container = currentEditor.view.dom.closest(".task-scroll")?.getBoundingClientRect();
    const right = Math.min(window.innerWidth - 12, container?.right ?? window.innerWidth - 12);
    const left = Math.max(container?.left ?? 12, Math.min(rect.left, right - 260));
    const above = rect.bottom + 330 > window.innerHeight;
    setMenu((previous) => {
      if (previous?.query !== query.query) setHighlight(0);
      return { ...query, left, top: above ? rect.top - 8 : rect.bottom + 8, above };
    });
  };
  const syncRef = useRef(syncMenu);
  syncRef.current = syncMenu;

  const choose = (index: number): void => {
    if (!editor || !menu) return;
    const command = matchingCommands(menu.query)[index];
    if (!command) return;
    editor.chain().focus().deleteRange({ from: menu.from, to: menu.to }).run();
    setMenu(null);
    if (command.id === "image") pickImageRef.current();
    else command.run(editor);
  };

  const handleKeyDown = (event: KeyboardEvent): boolean => {
    const current = menuRef.current;
    if (!current) return false;
    const count = matchingCommands(current.query).length;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setHighlight((index) => (count ? (index + (event.key === "ArrowDown" ? 1 : -1) + count) % count : 0));
      return true;
    }
    if (event.key === "Enter" && !event.metaKey && !event.ctrlKey) {
      event.preventDefault();
      choose(highlighted.current);
      return true;
    }
    if (event.key === "Escape") {
      dismissed.current = `${current.from}:${current.query}`;
      setMenu(null);
      return true;
    }
    return false;
  };

  const open = (): void => {
    if (!editor) return;
    editor.commands.focus();
    const { from, to } = editor.state.selection;
    const rect = editor.view.coordsAtPos(from);
    setHighlight(0);
    setMenu({ from, to, query: "", left: Math.min(rect.left, innerWidth - 272), top: rect.bottom + 8, above: false });
  };

  useEffect(() => {
    if (!menu || !editor) return;
    const reposition = () => syncRef.current(editor);
    const close = (event: PointerEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest(".task-insert-menu")) {
        dismissed.current = `${menu.from}:${menu.query}`;
        setMenu(null);
      }
    };
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    document.addEventListener("pointerdown", close);
    return () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
      document.removeEventListener("pointerdown", close);
    };
  }, [editor, menu]);

  useEffect(() => {
    document.getElementById(`task-insert-${highlight}`)?.scrollIntoView({ block: "nearest" });
  }, [highlight]);

  const menuOpen = menu !== null;
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    const element = editor.view.dom;
    if (menuOpen) {
      element.setAttribute("aria-controls", "task-insert-options");
      element.setAttribute("aria-activedescendant", `task-insert-${highlight}`);
      element.setAttribute("aria-haspopup", "listbox");
    } else {
      element.removeAttribute("aria-controls");
      element.removeAttribute("aria-activedescendant");
      element.removeAttribute("aria-haspopup");
    }
  }, [editor, menuOpen, highlight]);

  return { menu, highlight, setHighlight, setMenu, syncMenu, handleKeyDown, choose, open };
}
