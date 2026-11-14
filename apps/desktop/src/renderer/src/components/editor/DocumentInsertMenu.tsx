import { createPortal } from "react-dom";
import { CoversPreview } from "../../lib/browser-preview";
import { matchingCommands } from "./commands";
import type { useDocumentCommands } from "./use-document-commands";

export function DocumentInsertMenu({ commands, source, imageUnavailableReason }: { commands: ReturnType<typeof useDocumentCommands>; source: boolean; imageUnavailableReason?: string }) {
  return commands.menu && !source
    ? createPortal(
        <div className="task-insert-menu" style={{ left: commands.menu.left, top: commands.menu.top, transform: commands.menu.above ? "translateY(-100%)" : undefined }}>
          <CoversPreview />
          <div className="task-insert-heading">Insert {commands.menu.query ? <span>“{commands.menu.query}”</span> : null}</div>
          <div id="task-insert-options" role="listbox" aria-label="Insert content">
            {matchingCommands(commands.menu.query).map((command, index) => (
              <button
                type="button"
                role="option"
                id={`task-insert-${index}`}
                aria-selected={commands.highlight === index}
                key={command.id}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => commands.setHighlight(index)}
                disabled={command.id === "image" && Boolean(imageUnavailableReason)}
                data-tip={command.id === "image" ? imageUnavailableReason : undefined}
                onClick={() => commands.choose(index)}
              >
                <command.icon size={17} />
                <span>{command.label}</span>
              </button>
            ))}
            {matchingCommands(commands.menu.query).length === 0 ? <p className="task-insert-empty">No matching commands</p> : null}
          </div>
        </div>,
        document.body,
      )
    : null;
}
