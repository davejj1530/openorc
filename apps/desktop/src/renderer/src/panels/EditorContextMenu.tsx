import type { ReactNode, RefObject } from "react";
import { ContextMenu } from "@base-ui/react/context-menu";
import type { CodeEditorActions } from "../components/code-editor";
import { menuItem, menuPopup } from "../components/menu";
import { CoversPreview } from "../lib/browser-preview";
import { floatingGround } from "../lib/use-anchor-ground";

export function EditorContextMenu({
  children,
  actions,
  supported,
  readOnly,
  format,
}: {
  children: ReactNode;
  actions: RefObject<CodeEditorActions | null>;
  supported: boolean;
  readOnly: boolean;
  format: () => void;
}) {
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger
        className="file-code-canvas"
        onKeyDown={(event) => {
          if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
          event.preventDefault();
          const { left, top } = event.currentTarget.getBoundingClientRect();
          event.currentTarget.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: left + 40, clientY: top + 20 }));
        }}
      >
        {children}
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <CoversPreview />
        <ContextMenu.Positioner collisionPadding={8} className="z-40">
          <ContextMenu.Popup ref={floatingGround} className={menuPopup}>
            {supported ? (
              <>
                <ContextMenu.Item className={menuItem} onClick={() => actions.current?.definition()}>
                  Go to definition
                </ContextMenu.Item>
                <ContextMenu.Item className={menuItem} onClick={() => actions.current?.references()}>
                  Find references
                </ContextMenu.Item>
                <ContextMenu.Item className={menuItem} onClick={() => actions.current?.outline()}>
                  Outline
                </ContextMenu.Item>
                <ContextMenu.Item className={menuItem} onClick={() => actions.current?.problems()}>
                  Problems
                </ContextMenu.Item>
                <ContextMenu.Item className={menuItem} disabled={readOnly} onClick={() => actions.current?.quickFixes()}>
                  Quick fixes
                </ContextMenu.Item>
              </>
            ) : null}
            <ContextMenu.Item className={menuItem} disabled={readOnly} onClick={format}>
              Format document
            </ContextMenu.Item>
          </ContextMenu.Popup>
        </ContextMenu.Positioner>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
