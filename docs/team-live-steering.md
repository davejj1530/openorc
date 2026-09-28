# Team corrections during active work

Teams are in Beta and enabled for new profiles. Manage **Team execution (Beta)** in Settings → General → Orchestration; existing on/off choices are preserved.

## Sending while a team works

While a team is working, Enter and the send button deliver your message right away to the members it is for. **Queue** holds it for the recipient's next turn instead. Between turns, sending starts the next turn as usual. Ordinary conversations work the same way: Enter sends into the running turn, and **Queue** waits for the next one. Mentions in your message choose the recipients.

How a message reaches a working agent depends on its provider:

- **Codex** takes it into the current turn with `turn/steer`.
- **Claude Code** takes it as a new message in its running turn.
- **OpenCode** cannot take input during a turn, so messages to OpenCode, in a team or an ordinary conversation, always wait for its next turn.

A live send also delivers earlier messages still waiting for that member, in order, each with its own attachments. Messages you queue afterwards stay queued. If the member has finished worker results it has not taken in yet, your message waits for its next turn so those results are merged into its workspace first.

## Delivery status

Each recipient shows **Sending…**, **Sent**, or **Queued for next turn**. Sent means the provider accepted the message, not that the agent acted on it; its reply and actions show that.

If the turn ends before the message arrives, the message stays queued for the next turn. If OpenOrc cannot tell whether the provider received it, the chat shows **Couldn’t confirm delivery · review before retrying**, and the member needs your attention. OpenOrc does not resend the message on its own, including after Stop or a restart. Check the member's turn before sending it again.

## Who replies

- A member replies in the chat when someone expects an answer: you address it, or the lead or a colleague names it in `team_say`, either in `to` or as an @mention in the text.
- Otherwise the member reads the message as context. Only what it posts with `team_say` appears in the chat; its final text stays private.
- A colleague @mentioned in a member's reply reads it without replying. Mentioning the lead in a reply wakes the lead to act.
- A member you already addressed does not answer again when the lead relays your message. A correction sent only to the lead starts a new request, so members the lead relays it to do reply.
- Replies between colleagues are limited per request by **Follow-ups after colleagues**. After that limit, a colleague's message is read, not answered.
- A member that is mid-turn when named reads the message after its turn ends. The chat shows it as reading the message on its next turn.

New teams have **Reads per message** set to **Off** and **Follow-ups after colleagues** set to **None**, so members work only when addressed. Change both in the team editor's **Discussion** section when you want more participation. Teams saved with other values keep them.

The lead is instructed to acknowledge you promptly, check its current workers, and relay your correction only to the members it affects, using `team_say` or `team_message`. Neither tool broadcasts or copies earlier recipients on its own. These are instructions to the model: OpenOrc guarantees routing and delivery, not that the model follows them.

## Scheduling

When you message the lead, its turn goes ahead of other lead, manager, worker and background turns. If the team is already running its **Concurrent agents** limit, one extra lead turn is allowed so the lead can respond to you. That extra turn counts toward the limit for everyone else.

Workers are never interrupted to make room. Workspace preparation or recovery can still delay the lead. Agent processes kept open between turns do not count toward the limit, and there is no separate per-provider limit, so separate teams do not compete for turns.

## Diagnosing slow coordination

Measure delivery, time spent waiting to start, and total turn time separately. A quick **Sent** does not mean a later turn started quickly or that the model acted on the message. Members work in parallel, so do not add their times together as elapsed time.

`python3 scripts/team-timeline.py /path/to/openorc.sqlite EXECUTION_ID` reports counts and timing from a saved team run without printing prompts or tool contents. The saved data does not fully separate model time, waiting for capacity, and workspace preparation before a turn starts. Compare similar workloads before crediting a speed change to scheduling.

Automatic turns reuse a recent provider readiness check. A failed check is retried with a fresh environment before the turn is refused, so a recent install or sign-in is picked up. **Check readiness** in the team editor always checks again.

## For contributors

- Coordinator tests cover in-order delivery, attachments, replay, one delivery at a time, startup, compaction, unavailable and unconfirmed deliveries, completion races, Stop and restart, relaying to isolated workers, and provider limits.
- A public RPC and MCP scenario fills the team's capacity with three active workers; a user correction starts the lead, whose targeted relay reaches one worker before any worker finishes.
- `node scripts/composer-steering-ui-smoke.cjs` runs the production composer in Electron. It covers Enter, click, explicit queueing, an unavailable provider, idle and solo behavior, Shift and IME input, attachments and failed-send retry, with screenshots in both themes at 900px and 520px.

These checks use scripted providers through the real runtime and make no paid model calls.
