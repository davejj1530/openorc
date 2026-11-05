import { useState, type ReactNode } from "react";
import { Button, Input, TextButton } from "../components/ui";
import { SettingRow } from "./settings-shared";

/** A sign-in removed here keeps working where it was made until revoked there, on these pages. */
const REVOKE = {
  claude: { until: "still works until you revoke it in ", place: "your Claude settings", url: "https://claude.ai/settings/claude-code", tail: ", under Claude Code." },
  chatgpt: { until: "stays signed in until you log out its session in ", place: "ChatGPT", url: "https://chatgpt.com", tail: ", under Settings > Security." },
  apiKey: { until: "still works until you delete it in ", place: "your OpenAI account", url: "https://platform.openai.com/api-keys", tail: "." },
} as const;
export type RevokedAt = keyof typeof REVOKE;

/** Said once a sign-in was removed, or as it is about to go: where to revoke it so it stops working everywhere. */
export function StillWorks({ at, subject = "Removed from OpenOrc. It " }: { at: RevokedAt | null; subject?: string }) {
  if (!at) return null;
  const { until, place, url, tail } = REVOKE[at];
  return (
    <p className="text-ink-3 mt-2">
      {subject}
      {until}
      <TextButton underline onClick={() => window.openorc.openExternal(url)}>
        {place}
      </TextButton>
      {tail}
    </p>
  );
}

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
