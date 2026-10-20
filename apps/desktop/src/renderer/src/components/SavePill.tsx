import { useEffect, useState } from "react";
import { Check } from "./icons";
import { Button } from "./ui";

const CONFIRM_MS = 1600;

/**
 * Save as a pill that confirms in place: once a save is acknowledged (`savedAt` moves on) the
 * label swaps to Saved with a check, then back. Only an acknowledged save is announced; the
 * pill keeps its name, Save, throughout.
 */
export function SavePill({ onSave, disabled, pending, savedAt }: { onSave: () => void; disabled: boolean; pending: boolean; savedAt: number | null }) {
  const [confirmed, setConfirmed] = useState<number | null>(null);
  useEffect(() => {
    if (savedAt === null) return;
    setConfirmed(savedAt);
    const timer = setTimeout(() => setConfirmed(null), CONFIRM_MS);
    return () => clearTimeout(timer);
  }, [savedAt]);
  const saved = confirmed !== null && !pending;
  return (
    <>
      <Button aria-label="Save" disabled={disabled} onClick={onSave} className="motion-swap">
        <span aria-hidden={saved ? "true" : undefined}>{pending ? "Saving…" : "Save"}</span>
        <span aria-hidden={saved ? undefined : "true"} className="inline-flex items-center justify-center gap-1.5">
          <Check size={14} /> Saved
        </span>
      </Button>
      <span role="status" className="sr-only">
        {saved ? "Saved" : ""}
      </span>
    </>
  );
}
