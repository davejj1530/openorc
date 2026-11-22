# Multiple Claude Code accounts

OpenOrc supports any number of named Claude Code accounts. Add them in **Settings → Connections → Claude accounts**, then choose one when starting a Claude thread, opening or continuing a task's thread, refining a task, setting up a task button, creating a schedule, or designing an Orcling.

## Add an account

1. Enter a name such as Personal, Work, or a client name.
2. Select **Add account and sign in**.
3. Complete Claude's sign-in in the Chrome Incognito window that opens, so your browser's own Claude login stays as it is. Without Chrome, or on Windows, sign-in opens in your default browser. The account row shows the signed-in email and organization when Claude reports them.

Use **Make default** for new conversations. An explicitly selected account stays with a saved draft. Existing conversations, forks, child threads, and schedules retain their saved account when the default changes.

**Settings → Usage** shows each enabled Claude account separately. Model availability, Fast mode access, live allowances, and limits observed during runs are kept separate too. Two entries signed in to the same provider account still share that provider's allowance.

## Existing conversations and recovery

The **Existing CLI login** entry preserves the Claude login OpenOrc used before this feature. Existing conversations and imported CLI history stay attached to it. Rename this entry if useful.

A thread keeps its account until you move it. With more than one account, the account name in the thread header opens a menu that moves the conversation to another account between turns. OpenOrc copies the newest Claude session into the other account's folder, and the next message resumes that copy; when there is no session to copy, the thread starts over there with a summary of the conversation. When a run stops on a usage limit, the conversation offers the other signed-in accounts and continues where it left off on the one you choose. With **Switch accounts at usage limits** turned on, it moves by itself to the account with the most 5-hour usage left; a project that uses only selected accounts has its own switch. Tasks keep the account they ran on, and an Orcling keeps its own.

Disabling an account retains its history and credentials; enable it again to continue its conversations. OpenOrc reports an unavailable or disabled account instead of selecting a different login.

**Sign in again** closes idle sessions for that account, preserving their conversation history. Finish active work first. Sign-in can be cancelled and times out after five minutes. If it fails, check the Claude Code installation, retry, and complete the browser flow.

## Keep accounts separate

**Keep accounts separate**, under **Settings → Connections → Claude accounts**, stops work on one account from seeing or reaching work on another, even in the same project:

- An agent's thread tools list, read and message only threads on its own account, and its task tools see only tasks that run in, or were saved from, a thread on its account. A task with no thread stays visible to every account.
- A thread on another agent, such as Codex, belongs to the Claude account it started under, which its model picker shows, and its agent sees only that account's work.
- A subthread, fork, task thread or scheduled run carries its account over. Where the project no longer uses that account, it doesn't start, instead of moving to the project's default.
- No conversation moves to another account, yours included: the account menu in the thread header is off, and a run stopped by a usage limit offers no other account to continue with. A task's new threads, Refines and buttons stay on the account the task is on, whatever account a button names. A new thread can still start on any account the project uses.
- Nothing switches account at a usage limit, whatever the app or project setting says.
- Each added account keeps its own Claude memory instead of the shared folder. Memories saved before you turn the setting on stay in the existing CLI login's folder, where its threads still read them, and turning it off moves each account's memories into that shared folder for good. A memory file whose name the shared folder already uses for a different memory stays behind in its account's folder, unused.
- Claude's file tools can't open another added account's folder, or the existing CLI login's sessions, memory, prompt history, sign-in, plans, file snapshots, pasted text, to-dos, background jobs, backups and logs. A shell command still can, since every account runs as you on the same computer, and OpenOrc running on Windows itself, rather than in WSL, doesn't set this yet. Claude Code's skills and plugins stay shared.
- An Orcling starts work, messages other Orclings, and acts in OpenOrc only on its own account, and lists only what is on it. It doesn't answer the comments on, or refine, a task on another account, and it doesn't reach OpenOrc Cloud's threads and tasks, which no account here holds. A group chat of Orclings on different accounts can't be made, and one made before stays quiet until the setting is off.

The thread, task and Orcling rules follow the setting at once. Memory and the file rules apply when a session starts, so turning the setting on or off closes idle sessions; one already working keeps the old ones until it next starts.

## Credential ownership

Claude Code handles browser authentication, credential storage, and token refresh. OpenOrc stores account names and identifiers, not the CLI's OAuth tokens. Managed accounts use separate `CLAUDE_CONFIG_DIR` directories inside OpenOrc's data directory, following [Claude Code's multiple-account support](https://code.claude.com/docs/en/authentication#log-in-with-multiple-accounts). Each has separate Claude settings and session history. Project files and project instructions remain shared.

Unless you keep accounts separate, Claude's memory is shared as well: every added account reads and saves memories in the **Existing CLI login**'s memory folders, so what Claude learns about a project on one account is there on the others. Memories an account saved on its own before this move into the CLI login's folder for the same project. A memory file whose name the CLI login already uses for a different memory stays in the account's folder, unused.

Added accounts use the skills and plugins installed for the **Existing CLI login**, so `/` offers the same skills whichever account a thread runs on. OpenOrc links each personal skill into the account's own `skills` folder and removes the link once the skill is uninstalled. Plugins turned on for the CLI login are loaded into each run with `--plugin-dir`, with nothing installed in the account. Skills an account installs itself, and the claude.ai skills Claude Code syncs for it, stay with that account.

The existing CLI entry keeps the inherited environment. Managed entries remove inherited Anthropic API keys, OAuth token overrides, and cloud-provider selectors from their launch environment so those values cannot override the chosen Claude login. Adding an account does not change the login used by your ordinary terminal.

## Cloud tokens

**Sign in with Claude** under **Settings → Cloud → OpenOrc Cloud** makes the token your cloud turns sign in with. It runs `claude setup-token` through the account you choose under **Claude account**, when this computer has more than one, and sends the token to OpenOrc Cloud, which keeps it. **Use an API key** takes an Anthropic API key instead. **Remove** deletes the cloud's copy; it does not revoke the token at Anthropic.
