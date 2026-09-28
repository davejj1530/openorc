# Slack

Mention an OpenOrc bot in Slack to start work on your desktop. Agents run on your computer with your own provider logins; Slack carries the conversation, live progress, and approval buttons.

**Settings → Slack** offers two connection types:

- **Personal bot · no server needed** connects this desktop directly to Slack using Socket Mode. It needs no hosted service, HTTP listener, relay address, device key, or SSH tunnel. New setups use this type.
- **Team relay · advanced** shares one Slack bot across several desktops through a relay hosted by one of them. See [Advanced: team relay](#advanced-team-relay).

Each desktop needs a signed-in coding-agent CLI and an accessible entrypoint folder (a Git repository is optional). The integration does not need a model API key.

## Connect a personal bot

1. Choose **Personal bot · no server needed**. If a relay connection is active, disconnect it and let pending delivery finish before switching connection types.
2. Expand **Set up your Slack app**, choose a distinct app name (for example, OpenOrc Personal), and click **Create Slack app**. The link supplies an app manifest with Socket Mode, interactivity, channel events, bot scopes, and the `agent_view` feature for native Markdown replies. If Slack does not prefill the form, use **Copy manifest** and create an app from JSON. Workspace administrators may need to approve installation.
3. In Slack’s app settings, open **OAuth & Permissions → Install to Workspace** and copy the `xoxb-…` Bot User OAuth Token.
4. Open **Basic Information → App-Level Tokens → Generate Token and Scopes**. Add `connections:write` and copy the `xapp-…` token. Both tokens must come from the same app.
5. Copy your own Slack member ID from your profile’s **More** menu. Enter it and both tokens in OpenOrc, then choose the Workspace entrypoint, default coding agent, optional default model, and mode.
6. Click **Connect and check**. OpenOrc verifies bot authentication, checks that the member is an active human in the bot’s workspace, and opens the Socket Mode connection. The manifest includes `users:read` for this check; an app created without it needs that scope and a reinstall.
7. Invite your bot to a channel and mention it from the connected member account. Reply normally inside that thread afterward. Private channels also require inviting the bot. This first request checks channel access and reply delivery, which the connection check alone cannot confirm.

The template follows Slack’s [manifest schema](https://docs.slack.dev/reference/app-manifest/) and enables AI app features used by [Markdown blocks](https://docs.slack.dev/reference/block-kit/blocks/markdown-block/).

Each teammate creates a **separate Slack app and tokens** for their own desktop. Sharing one app’s tokens across desktops is unsupported: Socket Mode does not route connections by the mentioning user. Only the configured member can start work or approve actions through that personal bot; other participants’ messages in an activated thread may be included as context. Member selection is local configuration by the trusted computer owner, not an OAuth identity proof.

Keep OpenOrc open and the computer awake. A connection that drops while OpenOrc is open reconnects on its own, with growing waits up to a minute. After restarting the app, reconnect explicitly; saved credentials do not start agent work on their own. Tokens are stored encrypted (see [credential storage](credential-storage.md)), are never returned by Settings reads, and blank token fields keep their saved values. Disconnecting keeps a running request and its pending answer for the next connection; it does not stop the agent. **Check connection** retries pending delivery without rerunning completed work. Disconnect before changing credentials or execution defaults. Switching connection types keeps both configurations.

## Mode and approvals

The **Mode** field offers the same modes as desktop conversations, labelled for the selected coding agent: **Plan**, **Review everything**, **Accept edits**, and **Autonomous** for Claude Code and OpenCode, or **Plan**, **Review changes**, **Ask for approval**, and **Full access** for Codex. The hint below the field describes what the selected mode allows. The default is **Review everything** (**Review changes** for Codex). OpenCode runs only in **Plan** or **Autonomous**: in **Review everything** or **Accept edits** it refuses to start, because this integration cannot guarantee approval before every command, and the hint says so.

The selected mode applies to every Slack turn, including existing threads, and a stricter conversation mode is always respected. The default agent and model apply to new conversations.

Permission requests appear in the originating Slack thread with their redacted tool or command details. **Allow once** and **Deny** resolve the same live pending approval shown on the desktop. Buttons are bound to the workspace, the owner, the channel, the message, and the request. Other users, replayed decisions, and expired buttons cannot approve work. A desktop decision also removes the Slack buttons on the next synchronization.

Buttons expire after ten minutes, and restarting OpenOrc or the relay invalidates earlier buttons. Long requests are split into numbered messages containing the complete redacted details. **Allow once** and **Deny** appear only on the final message, after all parts have been delivered. A failed delivery resumes from the unsent part; it does not make a partial request approvable. Questions that need a written answer are answered in OpenOrc on the desktop. Approval details and replies are visible to members of the channel. Decisions use Slack’s [block action payloads](https://docs.slack.dev/reference/interaction-payloads/block_actions-payload/) delivered over the authenticated Socket Mode connection.

## Workspace conversations and folders

The **Workspace** group at the top of the thread list, marked with a globe icon, holds direct chats and Slack conversations, separate from project threads. Choose a direct chat’s folder with **Choose folder** when you start it; configure the shared entrypoint in **Settings → Slack**. The default entrypoint is an empty folder in OpenOrc’s application data directory. Changing the entrypoint affects new conversations; existing conversations keep their own folder.

- Mentioning the bot with `hi` starts a normal conversation with the configured default model in the Workspace entrypoint.
- `what model are you using right now?` goes directly to that model. It can inspect its actual harness and model with `execution_context`.
- `read my-app using Claude Opus and tell me what it is about` lets the model inspect available models and folders, then call `execution_switch` with the selected catalog IDs.
- Switching to an OpenCode model only works when the Slack mode is **Plan** or **Autonomous**. In the other modes OpenCode refuses to start, and the request returns to the default model, which explains the failure.
- An accepted switch takes effect after the current turn ends. OpenOrc continues the same request in the same conversation with the selected model or folder and a history handoff. You do not need to repeat the request.
- The conversation model asks about ambiguous requests in ordinary Slack replies. Reply normally in the same thread; no repeat mention is needed.
- `use Astra on high` switches model and reasoning effort together. `use low effort` changes only effort; `use default effort` clears the override. Unsupported effort levels are rejected using the selected model’s catalog. Folder-only switches keep the effort; switching to a different model without specifying effort uses its default.
- Later replies keep the chosen model, effort, and folder. New conversations start with the configured default again.

Discovery examines up to 250 directories, three levels beneath the entrypoint, skipping symlinks, hidden folders, and common dependency and build directories. It does not import them. Imported projects remain available even when outside the entrypoint. To work in another location, choose an entrypoint that contains it on the desktop first; Slack requests cannot add paths outside these scopes. The entrypoint is a discovery scope and initial working directory, not an OS sandbox; the selected provider’s permission policy still governs execution.

Slack messages go straight to the conversation model. There is no keyword parser, separate intent classifier, or dependency on the Text generation setting. `execution_context` exposes authoritative run metadata (including configured effort) and the available model and folder catalogs, with supported effort levels and model defaults. `execution_switch` validates exact selections, keeps permissions, and queues a fresh provider session in the same thread. Cancellation does not launch a queued switch.

If a run fails, OpenOrc starts one recovery turn with the configured default model, carrying the provider error and original request. The recovery model can explain the problem and select an explicitly requested alternative; it cannot sign in for you. Failed model IDs are blocked for the rest of that request. If the default also fails, recovery stops with the actual error instead of looping. An existing conversation whose last run failed also returns to the default when its owner replies. These tools are bound to the authenticated active Slack run; a caller cannot supply another user’s run or thread ID.

Conversation ownership is `(Slack workspace, user, channel, root thread)` on the receiving desktop. Each run records its working folder, harness, model, and permissions. Workspace has no Git worktree, checkpoint, commit, or PR controls; use an imported project’s conversation for managed Git review. Slack arrivals update the thread list without changing the desktop view.

Workspace composers accept text and attachments. Project-indexed file mentions and skill suggestions are not offered there; the agent still reads the selected folder and its own applicable instructions.

## Thread replies and readable messages

The first mention activates a conversation for that user in that channel and thread. Later ordinary replies from that user continue their own desktop conversation. Other participants’ messages are included as quoted context; they do not start work on another user’s machine. A teammate starts their own desktop conversation with their own first mention. Bot messages, edits, deletions, and unrelated threads do not start work. Activation is remembered across restarts.

Thread replies rely on Slack’s [message event subscriptions](https://docs.slack.dev/reference/events/message/) (`message.channels` and `message.groups`) and the matching `channels:history` and `groups:history` scopes. Before delivering a request, OpenOrc reads every page of the Slack thread through the triggering message with [conversations.replies](https://docs.slack.dev/reference/methods/conversations.replies/). The model receives the opener and earlier replies, including messages before the first mention, in chronological order. These messages are also saved in the desktop conversation. If Slack denies or rate-limits history access, the model receives an explicit missing-history warning along with the context already captured, and is told not to claim it saw missing messages. History loading follows Slack’s rate limits, and the provider’s context capacity still applies to very large threads. Same-thread replies received during a turn are queued in order, up to 20 per device; requests from other threads receive a busy response.

Owner messages are saved individually before the provider starts. Clarifying questions are ordinary assistant messages in the run transcript, so both sides of the conversation are visible on the desktop. Provider activity from earlier runs is not reconstructed from Slack.

A live reply appears during execution, showing the current model, startup or tool status, and the latest public assistant text. Updates are coalesced to at most one every two seconds per request through [chat.update](https://docs.slack.dev/reference/methods/chat.update/); the final answer replaces that same message. Message correlation survives relay restarts, and late progress cannot overwrite a finished reply. Progress delivery is best effort and does not expose reasoning, raw tool input, or tool output.

If Slack rejects editing the progress message because it was deleted, its block types cannot be replaced, its edit window closed, or it cannot be updated, the final answer is posted as a separate thread reply. Other delivery failures keep the completed answer for retry. Settings distinguishes a reachable connection with pending delivery from a disconnected one, shows a short Slack error code, and offers a retry. Retrying waits for a real attempt and does not rerun the agent. Timeouts do not trigger a new-message fallback because the original update may have succeeded.

Replies use Slack’s [native Markdown block](https://docs.slack.dev/reference/block-kit/blocks/markdown-block/), which supports standard headings, bold, links, code, and tables for apps using platform AI features. Top-level text remains as the accessibility and notification fallback. Long replies use a short fallback preview below `chat.update`’s separate 4,000-character limit, accounting for escaping and multibyte characters; the formatted body keeps the complete answer up to the 11,500-character reply cap. The final reply is the last completed assistant message, not a provider summary that repeats progress commentary. When a Slack request switches models, the desktop model picker shows the change.

## Images from Slack

Images attached to mentions, earlier thread messages, and untagged image-only follow-ups are downloaded to the receiving desktop’s attachment storage. The local conversation shows previews beside their messages, and the selected coding agent receives the actual image files, including after a model switch. Images are reused across turns and after app restarts.

The setup manifest includes the `files:read` bot scope. For an existing Slack app, add **OAuth & Permissions → Bot Token Scopes → files:read**, then **Reinstall to Workspace**. The bot also needs access to the channel and thread. Slack [private file URLs require bearer authentication](https://docs.slack.dev/reference/objects/file-object/); OpenOrc downloads them on the Slack connection host and never sends bot tokens or private URLs to a model or a teammate’s desktop. Relay downloads require the device key and a file belonging to that device’s active request.

PNG, JPEG, GIF, and WebP images up to 20 MB and 40 megapixels use OpenOrc’s standard image validation and preview handling. Unsupported, inaccessible, or invalid files produce a notice in the desktop conversation and are reported to the model as unavailable. PDFs, other documents, external image links, and link-unfurl previews are not imported.

## Advanced: team relay

One Slack bot receives mentions through a relay hosted by one running OpenOrc desktop. Each teammate has a separate device key, assigned to their Slack member ID by the relay operator. The relay delivers work only to that key’s user. Local projects, agent credentials, permissions, and conversations stay on each desktop. Slack replies are visible in the shared channel.

The relay is intended for a small, trusted team. The operator registers devices manually; there are no user accounts or self-service identity verification.

### Set up the relay once

1. In Slack, enable Socket Mode, enable **Interactivity & Shortcuts**, and subscribe to bot events `app_mention`, `message.channels`, and `message.groups`. The app token needs `connections:write`; the bot token needs `app_mentions:read`, `chat:write`, `channels:history`, `groups:history`, and `files:read`. Install or reinstall the app and invite it to the channels where you want to use it. Public and private channels work when the bot is a member; see [Slack’s app mention documentation](https://docs.slack.dev/reference/events/app_mention/).
2. On the host computer, choose **Team relay · advanced** in **Settings → Slack** and expand **Host the Slack connection**.
3. Enter the `xoxb-…` bot token and `xapp-…` app token. Keep port **47831** unless it is already in use. There is no channel ID to configure.
4. Click **Save and connect relay**. A connected workspace confirms bot authentication and a Socket Mode connection. Channel access is checked by the first mention and reply.
5. Under **Teammates**, register each teammate’s Slack member ID (`U…`, copied from their Slack profile menu) and a descriptive device label. Copy the generated device key and give it privately to that teammate. The key is shown once. Removing a device invalidates its key; register again to replace it. Register the host’s own user too if the host will run requests.

The relay listens only on `127.0.0.1`, never on the LAN or public internet. Shared Slack tokens stay on the host. Saved tokens and local device credentials are encrypted using Electron safeStorage and the OS keychain or secret service in `slack-secrets.enc` under the OpenOrc data directory. Plaintext fallback storage is rejected. No secret values are returned by Settings reads or included in Slack RPC diagnostic logs.

### Connect each teammate’s desktop

On the host itself, use `http://127.0.0.1:47831` directly. On another computer, open an SSH tunnel to the host:

```sh
ssh -N -o ExitOnForwardFailure=yes -L 47832:127.0.0.1:47831 host-user@host-address
```

The host must have SSH access configured, and the teammate must be authorized to use it. Keep this command running and use **`http://127.0.0.1:47832`** as the relay address on that computer.

In **Settings → Slack → This computer**:

1. Enter the relay address and your own device key.
2. Choose a **Workspace entrypoint**, such as `~/dev`, then select the default coding agent, optional default model, and mode. See [Mode and approvals](#mode-and-approvals).
3. Click **Connect this computer**. Confirm the displayed Slack member ID is yours.

The host computer, each teammate’s app, and the tunnels must stay running and awake. Connections start explicitly after an app restart; saved settings alone do not start agent work. Only one relay should use a given pair of Slack tokens.

## Limits

- Mention the bot once per user, channel, and thread, then reply normally in that thread. History reads include the opener and earlier replies. Direct messages are not supported, non-image attachments are not imported, and editing or deleting an earlier message does not start work.
- One request runs per device at a time. Same-thread replies are queued (up to 20); requests in another thread receive a busy response.
- No new work is queued while a device is offline. Accepted requests keep their correlation across relay reconnects and restarts. An interrupted desktop request is never rerun automatically: check its local thread, then send a new mention if needed.
- Disconnecting the desktop stops delivery, not an already-running agent. Reconnect to deliver its result; use the local thread’s Stop control to cancel agent work.
- Live progress shows status and public assistant text; final replies are capped at 11,500 characters. Raw reasoning and tool transcripts are not posted. Full execution details remain in OpenOrc.
- HTTP and result retries are deduplicated while the relay retains them. A lost Slack API response can still produce a duplicate Slack reply after a retry; exactly-once posting is not guaranteed.
- The relay operator is trusted and provisions identities manually. Teammates should receive only their own device key, never the shared Slack tokens or another user’s key. Host OS and SSH access are separate from OpenOrc authorization.

## For contributors: automated checks

```sh
pnpm --filter @openorc/core test src/services/slack src/services/workspace-home.test.ts
pnpm exec tsx --test packages/mcp/src/index.test.ts
pnpm --filter @openorc/core typecheck
pnpm --filter @openorc/desktop typecheck
pnpm --filter @openorc/db test src/ledger.test.ts
node scripts/slack-settings-smoke.cjs
```

The core tests use fixtures for Slack and the providers. They cover the personal connection (no HTTP listener, owner-only execution and approvals, workspace validation, reconnect delivery, and secret-free status) and a relay with two independent desktops over loopback HTTP. They also cover model and folder switching, failure recovery, paginated history, missing history scopes, live progress, and final-message replacement. The Electron smoke script renders the real Slack settings against fixture RPCs in a disposable directory. None of these checks use real Slack credentials.
