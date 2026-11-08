# Oh My Pi

OpenOrc runs [Oh My Pi](https://omp.sh) (`omp`) the way it runs OpenCode: as an ACP server, started with `omp acp` for each run. Oh My Pi signs in to its own model providers, so its models are listed by the provider that serves them. Install it, then sign in with `omp login` or put a provider's API key in `~/.omp/agent/.env` (for example `ANTHROPIC_API_KEY=…`).

Update it from **Settings → Connections**. OpenOrc supports the native installer, an owned npm global installation, and the stable `can1357/tap/omp` Homebrew formula. Homebrew updates follow the tap's release and respect pins. See [coding-agent updates](agent-updates.md).

## Permissions

Oh My Pi has no per-session approval setting, so each run starts with its own `--approval-mode` and a settings overlay passed with `--config`. Both outrank a project's `.omp/config.yml`.

| OpenOrc mode      | Oh My Pi approval mode | What asks                 |
| ----------------- | ---------------------- | ------------------------- |
| Review everything | `always-ask`           | every edit and command    |
| Accept edits      | `write`                | commands                  |
| Autonomous        | `yolo`                 | nothing                   |
| Plan              | `always-ask`           | OpenOrc refuses what asks |

Commands and file deletes or moves come as `session/request_permission`. Other tools come as form elicitations, which OpenOrc shows as the same approval card. OpenOrc tells Oh My Pi it supports forms; without them Oh My Pi denies those tools and approves plans without asking.

The overlay also sets `tools.xdev: false`, so OpenOrc's tools are called and approved by their own names rather than as `xd://` devices, and `async.enabled: false`, so subagents finish inside the turn that started them.

## Questions and plans

- Oh My Pi's `ask` tool comes as a form, shown as OpenOrc's question card. Declining it ends the turn, as Oh My Pi does.
- In Plan, Oh My Pi drafts its plan in a file of its own and proposes it. OpenOrc reads the whole plan file, shows it as the conversation's plan, answers "Refine plan" and stops the turn. You implement it from OpenOrc or reply with changes.

## Messages during a turn

Oh My Pi advertises `_session/steering`, so a message sent while it works joins the running turn. While an approval or question is open, the message waits in the queue instead, since steering would dismiss the card.

## Connectors

Over ACP, Oh My Pi reads no MCP configuration of its own. OpenOrc's Connectors settings edit `~/.omp/agent/mcp.json`, which Oh My Pi's terminal sessions read, and hand the servers that are on to each run on this computer. Whether each one starts is asked of Oh My Pi in a throwaway session. Sign in to a server with Oh My Pi's own `/mcp reauth`.

## Pull request reviews

Oh My Pi has no notion of an untrusted checkout and loads a project's own tools, so a review run refuses a checkout that carries `.omp`, `.claude/tools` or `.codex/tools`. Otherwise it runs with `--no-extensions --no-lsp`, from a folder outside the checkout so the checkout's `.env` is not read.

## Cloud

- Sandboxes and the cloud brain install Oh My Pi's prebuilt binary from its build service, checked against the sha256 it publishes. Its npm package needs Bun, which they do not have. The brain installs it only once its Mac has it.
- Oh My Pi signs in there with the provider keys OpenCode uses in the cloud (Settings → Cloud): Anthropic, OpenAI, OpenRouter, Google, Groq, Mistral, xAI and DeepSeek. Account sign-ins, such as a ChatGPT or Claude plan, stay on this computer.
- Conversations move with `omp session pack` and `omp session unpack`.
