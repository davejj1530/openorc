import { useState } from "react";
import type { Editor } from "@tiptap/react";

/** Web and mail links only. A bare domain like example.com is a web address. */
function linkTarget(address: string): string | null {
  if (!address || /^(https?:\/\/|mailto:)/i.test(address)) return address;
  return /^[\w-]+(\.[\w-]+)+([/?#]\S*)?$/.test(address) ? `https://${address}` : null;
}

/** Edits the link on the selected text, in place of the formatting menu. An empty address removes it. */
export function LinkEditor({ editor, initial, onClose }: { editor: Editor; initial: string; onClose: () => void }) {
  const [href, setHref] = useState(initial);
  const [error, setError] = useState("");
  const close = () => {
    onClose();
    editor.commands.focus();
  };
  const apply = () => {
    const target = linkTarget(href.trim());
    if (target === null) {
      setError("Use a web address or a link beginning with https://, http://, or mailto:.");
      return;
    }
    const chain = editor.chain().focus().extendMarkRange("link");
    (target ? chain.setLink({ href: target }) : chain.unsetLink()).run();
    onClose();
  };
  return (
    <div
      role="group"
      aria-label="Edit link"
      className="task-link-editor"
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") {
          event.preventDefault();
          apply();
        }
        if (event.key === "Escape") {
          event.preventDefault();
          close();
        }
      }}
    >
      <input
        autoFocus
        aria-label="Link URL"
        placeholder="https://example.com"
        value={href}
        onChange={(event) => {
          setHref(event.target.value);
          setError("");
        }}
      />
      <button type="button" onClick={apply}>
        {href.trim() ? "Apply" : "Remove link"}
      </button>
      <button type="button" onClick={close}>
        Cancel
      </button>
      {error ? <p role="alert">{error}</p> : null}
    </div>
  );
}
