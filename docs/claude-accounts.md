# Multiple Claude Code accounts

OpenOrc supports any number of named Claude Code accounts. Add them in **Settings → Connections → Claude accounts**, then choose one when starting a Claude thread or creating a schedule.

## Add an account

1. Enter a name such as Personal, Work, or a client name.
2. Select **Add account and sign in**.
3. Complete Claude's sign-in in the Chrome Incognito window that opens, so your browser's own Claude login stays as it is. Without Chrome, or on Windows, sign-in opens in your default browser. The account row shows the signed-in email and organization when Claude reports them.

Use **Make default** for new conversations. An explicitly selected account stays with a saved draft. Existing conversations, forks, child threads, and schedules retain their saved account when the default changes. Claude members of a team use the conversation's selected Claude account.

**Settings → Usage** shows each enabled Claude account separately. Model availability, Fast mode access, live allowances, and limits observed during runs are kept separate too. Two entries signed in to the same provider account still share that provider's allowance.

## Existing conversations and recovery

The **Existing CLI login** entry preserves the Claude login OpenOrc used before this feature. Existing conversations and imported CLI history stay attached to it. Rename this entry if useful.

An existing thread keeps its account. Start a new thread to use another account. Disabling an account retains its history and credentials; enable it again to continue its conversations. OpenOrc reports an unavailable or disabled account instead of selecting a different login.

**Sign in again** closes idle sessions for that account, preserving their conversation history. Finish active work first. Sign-in can be cancelled and times out after five minutes. If it fails, check the Claude Code installation, retry, and complete the browser flow.

## Credential ownership

Claude Code handles browser authentication, credential storage, and token refresh. OpenOrc stores account names and identifiers, not OAuth tokens. Managed accounts use separate `CLAUDE_CONFIG_DIR` directories inside OpenOrc's data directory, following [Claude Code's multiple-account support](https://code.claude.com/docs/en/authentication#log-in-with-multiple-accounts). Each has separate Claude settings and session history. Project files and project instructions remain shared.

Claude's memory is shared as well. Every added account reads and saves memories in the **Existing CLI login**'s memory folders, so what Claude learns about a project on one account is there on the others. Memories an account saved on its own before this move into the CLI login's folder for the same project. A memory file whose name the CLI login already uses for a different memory stays in the account's folder, unused.

Added accounts use the skills and plugins installed for the **Existing CLI login**, so `/` offers the same skills whichever account a thread runs on. OpenOrc links each personal skill into the account's own `skills` folder and removes the link once the skill is uninstalled. Plugins turned on for the CLI login are loaded into each run with `--plugin-dir`, with nothing installed in the account. Skills an account installs itself, and the claude.ai skills Claude Code syncs for it, stay with that account.

The existing CLI entry keeps the inherited environment. Managed entries remove inherited Anthropic API keys, OAuth token overrides, and cloud-provider selectors from their launch environment so those values cannot override the chosen Claude login. Adding an account does not change the login used by your ordinary terminal.
