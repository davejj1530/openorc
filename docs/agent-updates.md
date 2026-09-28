# Coding-agent updates

Settings → Connections shows your installed coding agents, their versions, and available updates. When updates are available, a notice appears in the workspace; **Review updates** opens Settings → Connections. Dismissing the notice hides it for those releases; a newer release shows a new notice.

OpenOrc checks installed agents 30 seconds after startup and every six hours while open. Turn off **Check for agent updates automatically** in Connections to check only by hand. Checks read public version information from `registry.npmjs.org` or `formulae.brew.sh`; they do not send conversations, project paths, or account credentials. All open windows share one check and one update at a time. A background check never installs anything.

## What OpenOrc can update

**Update all** and each agent's own update button install only updates OpenOrc can apply to an installation it recognizes. On macOS and Linux, those are:

- npm global installations of Codex, Claude Code, and OpenCode, where the active npm global folder owns the executable.
- Homebrew casks for Codex and Claude Code, using the Homebrew installation that owns the cask and the cask's release information.
- Claude Code's standard native installer, using `claude update`. The version check follows `autoUpdatesChannel` (`latest` or `stable`) in your Claude settings file. Managed policies can hold an update back; OpenOrc checks the installed version afterwards.
- OpenCode's standard `~/.opencode/bin/opencode` installation, using `opencode upgrade --method curl`.

Windows, custom launchers, Homebrew formulas and taps, and other package managers get instructions for updating by hand. OpenOrc never replaces them with an npm installation. Prerelease or unrecognized version strings are reported as failed checks rather than offered as upgrades.

## While an update runs

An update waits for agent turns, approvals, teams, model discovery, and background generation to finish. Once it starts, OpenOrc holds new turns, closes idle agent processes, and lets scheduled runs wait until the update is done. Conversations stay saved and resume on a new process. Agent sessions in other applications are not affected by this.

Update commands run without a shell or administrator rights, with limited output and a three-minute timeout. On macOS and Linux, a failure or timeout stops the updater and any processes it started. Raw package-manager output is not shown in the app because it can contain registry credentials. OpenOrc checks the installation again just before updating and checks the version afterwards. Failed checks and updates stay visible with steps to recover. OpenOrc cannot undo changes a failed package manager made.

The OpenOrc app has its own updater; see [desktop releases and updates](desktop-updates.md).

Vendor references: [Claude Code updates](https://code.claude.com/docs/en/setup#update-claude-code), [OpenCode upgrade](https://opencode.ai/docs/cli/#upgrade), [Codex CLI](https://developers.openai.com/codex/cli).
