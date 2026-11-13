# fx

OpenOrc runs [Vercel Labs fx](https://fx.sh/) through its native [ACP interface](https://fx.sh/docs/using-fx/acp). The integration was verified with fx 0.0.16 on macOS. fx is experimental and currently distributes native binaries for macOS and Linux.

## Setup

Install fx using its [official instructions](https://fx.sh/docs), then connect a provider:

```sh
fx login                  # Vercel AI Gateway
fx setup                  # Vercel AI Gateway API key
fx login codex            # ChatGPT subscription
fx login grok             # Grok subscription
```

You can also configure an [OpenAI-compatible connection](https://fx.sh/docs/configure-fx/custom-model-connections), including a local server. Provider charges and subscription limits still apply. Local integration tests do not require an account or paid inference.

Rescan in **Settings → Connections**, then enable **fx**. It also appears in onboarding. Disabled agents stay out of model pickers and cannot start work. `OPENORC_FX_BIN` selects another installation; `FX_HOME` selects its native profile folder. Restart OpenOrc after rebuilding the backend so the new harness is available.

## Conversations

- Models and reasoning levels come from fx. Each saved choice includes the connection and model, so identically named models from different providers remain distinct.
- Text, reasoning, tool activity, approval requests, and reported token/context usage appear in the conversation. Follow-ups reuse the live session; stopped processes resume fx's saved session.
- Text messages can steer an active turn. Image attachments wait for a new turn. Stop cancels the active turn and pending approvals.
- **Ask** uses fx's permission rules and asks before changes. **Auto review** lets fx evaluate actions automatically and ask when needed. **Full access** runs without prompts, outside the sandbox. Saved fx rules remain in force where the native mode applies them. The mode is set through the launch environment, so OpenOrc does not overwrite the terminal's default permission mode.
- fx has no native read-only Plan mode, so OpenOrc does not offer Plan or task-discussion replies for it. Use a normal fx thread for work.
- OpenOrc's MCP tools are passed to each session. OpenOrc opts in to fx's saved profile servers; fx also loads approved project servers. Profile connectors connect lazily when used. Interactive questions use OpenOrc's `ask_user` tool.

OpenOrc does not expose fx's Fast control; fx owns that setting. Ultra is explicitly disabled for OpenOrc runs. fx can compact automatically; native manual compaction, forks, background-command controls, background text generation, memory distillation, cloud execution, and session transfer are not available through this integration. OpenOrc's **Compact context** action instead starts a fresh session with a short handover brief. Untrusted checkouts are refused because fx can load project configuration and tools.

## Settings

Connections checks `fx status --json` without a model request or interactive login. Recognized native installations update with `fx upgrade`; public release checks use `releases.fx.sh/latest.txt`. Development-channel installations stay manual.

Connectors lists fx's reported configuration without claiming that a saved server is connected. Personal servers can be added, edited, removed, and toggled in `~/.fx/mcp.json` (or `$FX_HOME/mcp.json`). Project servers remain project-owned. Use `fx mcp login <server-name>` for OAuth. Authorization headers are managed through native login or `bearer_token_env` in fx's configuration.

Skills lists `SKILL.md` files from fx's workspace and personal directories plus its standard compatibility locations. Invoke them with `$name`. New skills go into `.fx/skills` or `$FX_HOME/skills`. Custom skill availability remains owned by fx. Instructions use the project's `AGENTS.md` and the personal `$FX_HOME/AGENTS.md`.

Conversation token reports are per prompt. Account allowances and spend are not exposed as OpenOrc quota meters in this integration: use `fx usage`, `fx credits`, or the selected provider's dashboard. See [usage and costs](https://fx.sh/docs/using-fx/usage-and-costs).

## Verification

The native integration suite runs the installed CLI against an isolated local OpenAI-compatible server. It covers discovery, streaming, usage, provider switching, session resume, allow/deny approvals, steering, cancellation, and MCP without real credentials:

```sh
OPENORC_TEST_FX_BIN="$(command -v fx)" pnpm --filter @openorc/agents test src/fx
```
