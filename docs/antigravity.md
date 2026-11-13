# Antigravity

OpenOrc runs Antigravity CLI through its [official ACP interface](https://antigravity.google/docs/ide/extensions/acp/). Install the CLI from [Google's instructions](https://antigravity.google/docs/getting-started?tab=cli), then run:

```sh
agy acp --login
```

Complete the Google sign-in, rescan in **Settings → Connections**, and enable **Antigravity**. OpenOrc resolves `agy` from your login shell. `OPENORC_ANTIGRAVITY_BIN` can select another installation. The integration was checked with CLI 1.5.3.

Personal Google accounts can use the [free plan](https://antigravity.google/pricing) within its quota. A `GEMINI_API_KEY` in the launch environment instead selects Gemini API authentication, which uses that API account's quota and billing. OpenOrc does not purchase credits or a subscription.

## Conversations

- Models and thinking levels come from the installed CLI. OpenOrc identifies itself as OpenOrc; Google's ACP restrictions limit third-party models to certain other editors, so this integration exposes the Gemini models the server offers.
- Text, reasoning, images, tools, permission requests, questions, and reported token usage use the shared conversation interface. Follow-ups reuse the session; stopped processes reopen saved sessions.
- Messages during an active response use Antigravity's native prompt steering. Stop cancels the turn and outstanding permission requests.
- Plan selects Antigravity's native Plan mode and uses OpenOrc's plan tools. Act uses Autonomous. Review everything and Accept edits are unavailable because saved Antigravity permission rules can bypass individual approvals.
- OpenOrc supplies its MCP server per session with `--process-per-session`. Antigravity still reads its own customizations and configured servers. Untrusted checkouts are refused because their hooks and plugins can execute code.

## Settings

Connections checks sign-in using `agy models`, without prompting a model or opening a login flow. Native installations update with `agy update` using Google's public release manifest.

Connectors can edit, remove, enable, and disable user servers in `~/.gemini/config/mcp_config.json`. Project entries remain owned by the project. Enabled entries say **Configured**: the CLI's saved configuration does not establish that a server connected successfully. Use `/mcp` in Antigravity for connection status and server sign-in.

Skills lists the standard project `.agents/skills` and personal `.gemini` skill folders. Manifest and plugin skills remain available to Antigravity itself but are not enumerated here yet. New personal skills go in `~/.gemini/config/skills`. Antigravity owns skill availability.

Antigravity currently runs on the connected computer, including when controlled from a paired phone. Cloud execution, session transfer, conversation forks, native manual compaction, background text generation, and memory distillation are unavailable. OpenOrc's **Compact context** action instead starts a fresh session with a short handover brief.

## Account usage

Settings → Usage, the sidebar usage popup, and the paired phone show Antigravity's reported model quotas and reset times. Gemini and Claude/GPT pools stay separate. The sidebar meter uses the Gemini weekly pool, since Gemini models are available to OpenOrc through ACP. Five-hour limits appear only when the account reports them.

OpenOrc reads `agy --print /usage --output-format json` with the CLI's cached login. This native command returns structured quota data with zero model turns; it creates no conversation and does not spend model quota. Reads have a timeout and an output limit, start outside the project, and cannot open an interactive login. API-key connections instead point to Google AI Studio, since their usage belongs to the API account rather than the cached Antigravity login. This command was checked with CLI 1.5.3.

## Verification

Native configuration tests use an isolated profile and a placeholder API key. They never send model prompts or use a paid account:

```sh
OPENORC_TEST_ANTIGRAVITY_BIN="$(command -v agy)" pnpm --filter @openorc/agents test src/antigravity
```

Adapter tests cover prompt steering through both send paths, configuration, session loading, permissions, and cancellation. Live responses additionally require a signed-in account and available quota.
