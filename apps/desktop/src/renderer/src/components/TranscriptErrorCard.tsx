import { AlertCircle, Copy } from "./icons";
import { TextButton } from "./ui";

function updateCommand(message: string): string | null {
  if (/claude update/.test(message)) return "claude update";
  if (/codex update|npm i(nstall)? -g @openai\/codex/.test(message)) return "npm install -g @openai/codex";
  return null;
}

/** A failure the user has to act on, with the fix pulled out when the message names one. */
export function TranscriptErrorCard({ text }: { text: string }) {
  const message = text.replace(/^API Error:\s*(\d+\s*)?/, "");
  const command = updateCommand(message);
  return (
    <div className="error-card rounded-xl border border-bad/50 bg-bad-soft/40 px-4 py-3 text-sm">
      <div className="flex items-start gap-2">
        <AlertCircle size={14} className="text-bad mt-0.5 shrink-0" />
        <div className="min-w-0 flex-1 grid gap-2">
          <div className="text-ink">{message}</div>
          {command ? (
            <div className="flex items-center gap-2">
              <span className="text-ink-3">Run in a terminal:</span>
              <code className="px-1.5 py-0.5 rounded-md bg-surface-2 text-ink-2">{command}</code>
              <TextButton onClick={() => void navigator.clipboard.writeText(command)} aria-label="Copy command" tone="faint">
                <Copy size={12} />
              </TextButton>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
