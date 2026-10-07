import { useState } from "react";
import type { FileKey } from "../lib/file-drafts";
import type { FileSelection } from "../lib/layout";
import { currentPage, type PanelSession } from "../lib/panel-tabs";
import { discardFile, saveFile, unsavedFileOf } from "../lib/use-file-buffer";
import { Button, Dialog } from "./ui";

interface Closing {
  tabId: string;
  selection: FileSelection;
  key: FileKey;
}

const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path;

/**
 * Closing a file tab that holds unsaved edits asks first, so typing is never lost without a choice. `close` closes a
 * tab, `show` brings one forward: a save that meets a conflict leaves its tab open on the banner.
 */
export function useFileTabClosing(session: PanelSession, actions: { close: (id: string) => void; show: (id: string) => void }) {
  const [closing, setClosing] = useState<Closing | null>(null);
  const requestClose = (id: string) => {
    const tab = session.tabs.find((candidate) => candidate.id === id);
    const page = tab ? currentPage(tab) : null;
    const selection = page?.kind === "file" ? page.selection : null;
    const key = selection ? unsavedFileOf(selection) : null;
    if (selection && key) setClosing({ tabId: id, selection, key });
    else actions.close(id);
  };
  const finish = (action: (id: string) => void) => {
    if (closing) action(closing.tabId);
    setClosing(null);
  };
  const dialog = closing ? <UnsavedFileDialog closing={closing} onClose={() => finish(actions.close)} onShow={() => finish(actions.show)} onCancel={() => setClosing(null)} /> : null;
  return { requestClose, dialog };
}

function UnsavedFileDialog({ closing, onClose, onShow, onCancel }: { closing: Closing; onClose: () => void; onShow: () => void; onCancel: () => void }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setSaving(true);
    const outcome = await saveFile(closing.selection);
    setSaving(false);
    if (outcome.kind === "failed") setError(outcome.message);
    else if (outcome.kind === "saved" || !unsavedFileOf(closing.selection)) onClose();
    else onShow();
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onCancel();
      }}
      title={`Save changes to ${fileName(closing.selection.path)}?`}
    >
      <p className="mb-3 text-base text-ink-2">Your edits will be lost if you don’t save them.</p>
      {error ? (
        <p role="alert" className="mb-3 text-sm text-bad break-words">
          {error}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button
          disabled={saving}
          onClick={() => {
            discardFile(closing.key);
            onClose();
          }}
        >
          Don’t save
        </Button>
        <span className="flex-1" />
        <Button disabled={saving} onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" disabled={saving} onClick={() => void save()}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
    </Dialog>
  );
}
