# Cursor

OpenOrc runs Cursor CLI over its [Agent Client Protocol interface](https://cursor.com/docs/cli/acp). Install the CLI using [Cursor's instructions](https://cursor.com/docs/cli/installation), run `cursor-agent login`, then rescan in **Settings → Connections**. OpenOrc resolves `cursor-agent` from your login shell; `OPENORC_CURSOR_BIN` can select another installation.

Cursor keeps its login and sessions. An Anthropic API key alone does not sign this integration in. A free Cursor account can be used within whatever CLI allowance Cursor makes available; OpenOrc does not buy a subscription or increase that allowance.

## Conversations

- Models and their variants come from the installed CLI. Reasoning and speed variants appear as model choices rather than separate effort or Fast controls.
- Text, images, tool calls, permission requests, questions, and plan proposals appear in the conversation. Cursor resumes saved conversations with `session/load`.
- Plan mode hands the proposed document to OpenOrc and stops before implementation. Choose **Implement** to continue in Act mode.
- Act uses **Autonomous**. Cursor's saved permission rules may allow tools without asking, so OpenOrc does not offer **Review everything** or **Accept edits** for Cursor.
- Messages sent during a turn queue for the next turn. Cancellation remains available while a permission or question is pending.
- OpenOrc's MCP tools are supplied to each session without editing the project's or user's MCP files. Cursor also loads its own configured servers.
- Interactive questions use OpenOrc's `ask_user` tool because some Cursor models do not expose a native question tool. Native Cursor question requests are also handled when a model sends them.

## Settings

Connections reports the CLI version and its JSON authentication status. The native installation updates through `cursor-agent update`; OpenOrc reads the release version from Cursor's official installer without executing that installer.

Connectors reads Cursor's reported server status and can save or remove user servers in `~/.cursor/mcp.json`. Project servers remain owned by the project. Use Cursor's CLI to sign in to a server or change its approval and enabled state.

Skills lists `SKILL.md` files in the project's and user's `.cursor/skills` and `.agents/skills`, plus Cursor's `.claude` and `.codex` compatibility locations. New skills go in `.cursor/skills`. Cursor controls skill availability.

## Current limits

Cursor conversations run on the connected computer and can be controlled from a paired phone while it is available. Cloud execution, session transfer, conversation forks, native manual compaction, background text generation, and memory distillation are not supported yet. OpenOrc's **Compact context** action instead starts a fresh session with a short handover brief. Account allowances are available through the Cursor dashboard rather than in-app quota meters.

Untrusted checkouts are refused because Cursor can load their settings and MCP servers. The integration does not copy Cursor credentials into cloud workspaces.
