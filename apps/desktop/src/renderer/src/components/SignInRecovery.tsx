import { harnessCatalog, type ActivityRecovery } from "@openorc/protocol";
import { cn } from "../lib/cn";
import { runInTerminal } from "../lib/terminal-requests";
import { useThreadMedia } from "./ThreadImages";

/** A provider that signed out signs back in with its own CLI, in the Terminal of the thread that hit it. */
export function SignInRecovery({ provider, lead, className }: { provider: ActivityRecovery["provider"]; lead?: string; className?: string }) {
  const { fileScope } = useThreadMedia();
  const command = harnessCatalog[provider].loginCommand;
  return (
    <p className={cn("my-2 text-sm text-ink-2", className)}>
      {lead ? `${lead} ` : null}
      {fileScope ? (
        <button type="button" className="text-accent-ink hover:underline" onClick={() => runInTerminal(fileScope, command)}>
          Sign in
        </button>
      ) : (
        <>
          Run <code>{command}</code> in a terminal.
        </>
      )}
    </p>
  );
}
