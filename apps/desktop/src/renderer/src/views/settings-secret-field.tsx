import { useState, type ReactNode } from "react";
import { Button, Input } from "../components/ui";
import { SettingRow } from "./settings-shared";

export function Failure({ error }: { error: Error | null | undefined }) {
  return error ? (
    <p role="alert" className="text-bad mt-2">
      {error.message}
    </p>
  ) : null;
}

/** A secret typed once: it goes to the core and the field empties. */
export function TokenField({
  label,
  hint,
  action,
  busy,
  onSave,
  placeholder = "Paste token",
}: {
  label: string;
  hint: ReactNode;
  action: string;
  busy: boolean;
  onSave: (token: string) => void;
  placeholder?: string;
}) {
  const [token, setToken] = useState("");
  return (
    <SettingRow label={label} hint={hint}>
      <Input type="password" autoComplete="off" spellCheck={false} value={token} disabled={busy} placeholder={placeholder} onChange={(e) => setToken(e.target.value)} />
      <Button
        disabled={busy || !token.trim()}
        onClick={() => {
          onSave(token.trim());
          setToken("");
        }}
      >
        {action}
      </Button>
    </SettingRow>
  );
}
