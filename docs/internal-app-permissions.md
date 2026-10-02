# Permissions for OpenOrc's own tools

Agents in OpenOrc can call OpenOrc's own tools, such as tasks, memory, messages to other conversations, and the Preview browser. These tools come from a private MCP connection that OpenOrc creates for each agent process, with a random server name, a local address tied to that run, and a fixed list of tools. Other MCP servers, including one named `openorc` or one that copies these tool names, are treated as external tools.

## How each provider is told

Each provider is set up so it does not ask you about OpenOrc's tools itself. OpenOrc then applies the conversation's mode when a tool runs, so the rules below are the same for every provider.

- **Claude Code** gets exact `--allowedTools` entries for that connection.
- **Codex** gets a per-tool `approval_mode="approve"` override for that connection.
- **OpenCode** asks OpenOrc about each tool call. OpenOrc approves tools named `<server>_<tool>` from that connection. In Plan, OpenOrc's OpenCode configuration also allows these tools explicitly.

These settings apply only to that agent process. Your own MCP configuration and the provider's shell and file permissions are unchanged. See the [Claude CLI permission flags](https://code.claude.com/docs/en/cli-reference) and [Codex MCP configuration](https://developers.openai.com/codex/config-reference).

If a provider still asks, OpenOrc checks that the request really comes from that connection: for Claude, the full tool name must match one of its tools; for Codex, the server name reported by Codex must match; for OpenCode, the tool name must start with the connection's server name. Codex confirmation forms with no fields are accepted automatically. Questions, and forms that have fields, still show a card. OpenOrc never decides trust from display text or tool arguments.

## What each mode allows

| Tool action                                     | Plan    | Review everything | Accept edits | Autonomous |
| ----------------------------------------------- | ------- | ----------------- | ------------ | ---------- |
| Browser click, fill, press                      | blocked | asks              | asks         | allowed    |
| Typing into a password field                    | blocked | asks              | asks         | asks       |
| `memory_record`, `memory_feedback`              | blocked | asks              | allowed      | allowed    |
| `orcling_remember`                              | blocked | asks              | allowed      | allowed    |
| `orcling_instructions_update`                   | asks    | asks              | allowed      | allowed    |
| `thread_send` to a more permissive conversation | blocked | asks              | asks         | allowed    |
| `orcling_thread_start`                          | blocked | asks              | asks         | allowed    |

When OpenOrc asks, you see the usual approval card. **Allow for this run** covers later actions of the same kind in that run, except password fields, which ask every time.

Everything else is allowed in every mode, because it changes nothing outside OpenOrc's own records:

- Reading: `task_list`, `task_get`, `thread_list`, `thread_read`, `memory_search`, `task_context`, `execution_context`, the Orcling reads `orcling_recall`, `orcling_history`, `orcling_projects`, `orcling_project` and `orcling_thread_read`, and browser `open`, `snapshot`, `screenshot` and `scroll`.
- Asking you: `ask_user`.
- Documents: `task_create` in the backlog, `orcling_task_create`, `task_update`, and `plan_write`.
- Task comments: `task_comment_intent`, which records whether a comment asks for work. The work itself starts only after the agent's reply.
- `approve`: Claude Code's permission prompt. Claude Code calls it, not the model, to hand each tool request to OpenOrc's approval cards and mode rules.

An Orcling's tools exist only in runs where an Orcling speaks. Its permission caps the mode it works in anywhere: Approve runs as Review everything (Plan on OpenCode, which cannot ask first), Allow as Autonomous, and the stricter of the Orcling's and the conversation's rule wins. `orcling_thread_send` follows the `thread_send` rules below and can reach threads in any project. `orcling_thread_start` sets the Orcling working in a new project thread, or on a saved task that has no conversation of someone else's; that thread works as freely as the conversation that started it, within the Orcling's permission. See [Orclings](orclings.md).

`task_start` is refused in Plan. It marks the task in progress so the calling conversation can work on it; it does not start another agent. `execution_switch` changes a Slack request's model or folder, never its permissions. Team tools follow the team's own rules.

## Messages to other conversations

`thread_send` has three more rules:

- A message to a conversation in the same or a stricter mode is allowed. That conversation acts under its own permissions, so it can do nothing the sender could not.
- A chain of agent messages stops after 4 messages in a row with no one writing in between. The count is per conversation and kept in memory. A message from a person, in the app, Slack or a schedule, resets it.
- A retried call with the same `request_key` is delivered once. Without a key, the same text to the same conversation from the same run counts as a retry.

Messages to team conversations follow the same permission and 4-message chain checks. After admission, a message is queued for the team's lead while its execution is running. Starting a team member's provider session does not reset the chain; human direction does (`packages/core/src/services/thread-agent-tools.ts`).

## Memory and passwords

An agent cannot take over the topic key of a memory you wrote, or mark it wrong or stale. `memory_record` limits titles to 120 characters and bodies to 800. The project brief labels each memory with who saved it.

The Preview shares your signed-in sessions (see [agent access to the sidebar preview](agent-browser.md)). A fill aimed at a password field is refused by the page until you allow it; only then does OpenOrc send it again, marked as allowed. Agents cannot set that mark themselves.

## Nothing starts work on its own

`task_create` saves to the backlog by default. Delegating work to other agents exists only in team runs: in Plan it only proposes the work, and team members work under the team conversation's mode. External commands from any agent go through the ordinary approval rules.

## Default mode for new work

Choosing a mode in a permission picker saves it as your default (`app.settings.defaultPermissionMode`). New conversations and new schedules start with it. A task conversation takes its mode from the task's previous run, then from the conversation that created the task, and only then from the default. Existing conversations and schedules keep their own mode; changing the default never raises them. New work waits for settings to load before it can start. Until you choose, the default is **Accept edits**.

## For contributors

The policy is in `packages/core/src/services/app-actions.ts`, and `RunService.authorizeAppAction` applies it. The tools are implemented in [packages/core/src/mcp-host/](../packages/core/src/mcp-host/), with task and message rules in [thread-agent-tools.ts](../packages/core/src/services/thread-agent-tools.ts) and provider approval checks in [run-approvals.ts](../packages/core/src/services/run-approvals.ts).

- `packages/core/src/services/permissions.test.ts`: approval paths for each provider, copied tool names, external approvals in the same session, forms that need data, and task and forwarded-work policies. "App actions follow the conversation's mode" runs every app action in every mode for Claude and Codex, and in Plan and Autonomous for OpenCode, plus the message chain limit, request keys, and protection of your memories.
- `packages/agents/src/codex/adapter.test.ts`: approval for the OpenOrc connection only, with the sandbox and command policy unchanged; other MCP URLs get no exemption.
- `packages/core/src/services/settings.test.ts` and `packages/core/src/openorc.test.ts`: saving the default, older settings, and task start defaults.
- `apps/desktop/src/renderer/src/lib/permission-default.test.ts`: rapid selections and recovery from a failed save.

Provider tests run the real adapters, core, JSON-RPC transport and local MCP endpoint against scripted provider processes. They make no live model calls.
