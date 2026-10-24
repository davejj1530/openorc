import { harnessCatalog, type ActivityRecovery } from "@openorc/protocol";
import { cn } from "../lib/cn";
import { runInTerminal } from "../lib/terminal-requests";
import { useThreadMedia } from "./ThreadImages";
import { useClaudeAccountId } from "../lib/claude-account";
import { useRpc, useRpcMutation } from "../lib/client";
import { useRouter } from "../lib/router";

/** A provider that signed out signs back in with its own CLI, in the Terminal of the thread that hit it. */
export function SignInRecovery({ provider, lead, className }: { provider: ActivityRecovery["provider"]; lead?: string; className?: string }) {
  const { fileScope } = useThreadMedia();
  const claudeAccountId = useClaudeAccountId();
  const command = harnessCatalog[provider].loginCommand;
  if (provider === "claude" && claudeAccountId) return <ClaudeSignInRecovery lead={lead} className={className} />;
  return (
    <p className={cn("my-2 text-sm text-ink-2", className)}>
      {lead ? `${lead} ` : null}
      {fileScope && fileScope.kind !== "project" ? (
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

function ClaudeSignInRecovery({ lead, className }: { lead?: string; className?: string }) {
  const id = useClaudeAccountId();
  const accounts = useRpc("claude.accounts.list", {});
  const login = useRpcMutation("claude.accounts.login");
  const account = accounts.data?.accounts.find((entry) => entry.id === id);
  return (
    <div className={cn("my-2 text-sm text-ink-2", className)}>
      {lead ? `${lead} ` : null}
      {id ? (
        <button type="button" className="text-accent-ink hover:underline" disabled={login.isPending} onClick={() => login.mutate({ id })}>
          Sign in to {account?.name ?? "this Claude account"}
        </button>
      ) : null}
      {login.isSuccess ? <p role="status">Complete sign-in in your browser, then retry your message.</p> : null}
      {login.error ? <p role="alert">{login.error.message}</p> : null}
      <button type="button" className="text-accent-ink hover:underline ml-2" onClick={() => useRouter.getState().navigate({ view: "settings", section: "connections" })}>
        Manage Claude accounts
      </button>
    </div>
  );
}
