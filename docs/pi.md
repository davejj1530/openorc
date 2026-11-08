# Pi

OpenOrc drives [Pi](https://pi.dev) through its native RPC interface. Pi is a separate agent from Oh My Pi and has its own settings, provider credentials, and sessions.

## Setup

Install Pi 1.5.0 or newer:

```sh
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

Run `pi` and use `/login` to connect a provider, or configure one of Pi's supported API-key environment variables. Pi also supports compatible local model endpoints through `~/.pi/agent/models.json`. A paid Pi subscription is not required; the model provider's charges still apply.

In OpenOrc, rescan agents and enable **Pi** in **Settings → Connections**. Its available models come from Pi's own authenticated catalog. Disabled agents stay out of model pickers and cannot start work. After updating a development build, quit and reopen OpenOrc so its backend and interface run the same version.

Recognized npm global installations can be updated or reinstalled from Connections. Updates wait for agent work to finish; existing conversations resume on the next message. See [coding-agent updates](agent-updates.md).

## Behavior

- Responses, reasoning, tool output, token usage, and session costs appear in the conversation.
- Model and thinking changes apply to the live session between turns, with validation before the change and rollback if it fails.
- Follow-up messages reuse the live session. Stopped processes resume Pi's saved session, and conversation forks create separate Pi sessions.
- Messages can steer an active response. Stop clears queued inputs and aborts the turn.
- Image attachments reach Pi as image input; other attachments are named as files to read.
- Plan allows Pi's built-in reading tools and OpenOrc tools, whose own permission checks remain in force. Other tools are blocked. Plans are saved through OpenOrc's `plan_write` tool.
- Review asks before commands, edits, and external tools. Accept edits allows built-in file edits and asks before commands and external tools. Autonomous uses OpenOrc's normal automatic approval policy.
- Skills are discovered through Pi and inserted as `/skill:name`. MCP configuration stays in Pi's own files; OpenOrc's connection is registered only for the running session.

OpenOrc loads its permission extension and Pi's built-in MCP extension. Other Pi extensions are currently disabled in OpenOrc sessions, including custom provider extensions. Native configured models, skills, and prompt templates remain available. Configure MCP OAuth sign-ins with `pi mcp login <server>`.

Pi currently runs on the connected computer. Cloud execution, session transfer, background-command controls, background text generation, and memory distillation through Pi are not available.

## Verification

The adapter has tests against the actual CLI using an isolated profile and a local OpenAI-compatible endpoint. They exercise streaming, approvals, Plan, Stop, MCP, skills, follow-ups, resume, and forks without an account or paid requests:

```sh
OPENORC_TEST_PI_BIN="$(command -v pi)" pnpm --filter @openorc/agents test src/pi
```

Protocol references: [RPC commands](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc-commands.md), [events](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/json.md), and [MCP](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/mcp.md).
