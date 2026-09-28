# Product model

OpenOrc is an Electron desktop workspace for developers using installed coding-agent tools. Conversations, task documents, changes, and project context stay together across local repositories. OpenOrc stores its data on your machine, while each agent sends its requests to its own model provider.

## Conversations and work

Threads are durable conversations. Tasks describe bounded work, can belong to a thread, and execute in the configured local checkout or an explicitly selected isolated git worktree. Runs use the vendor CLIs. The local SQLite ledger feeds project memory. No OpenOrc account is required.

Workspace holds direct chats and new Slack conversations independently of imported projects. Each conversation keeps its own working folder, which need not be a Git repository. Choosing a folder for a new direct chat changes only its draft; Settings → Slack → Workspace entrypoint changes the shared default for new conversations and Slack folder discovery. Existing conversations retain their folders when that default changes. Background Slack arrivals refresh the thread list without navigating the desktop. Managed Git worktree, checkpoint, commit and PR controls remain in project conversations. Setup and routing details live in [docs/slack.md](docs/slack.md). Slack setup defaults to a personal bot connected directly from the desktop over Socket Mode, with a guided app manifest and local owner binding. Each user supplies their own Slack app; no hosted relay is required. A shared team relay is available as an advanced connection type.

Tasks open in a full-page document editor and save to backlog by default, whether created by the user or through MCP. Starting an agent is a separate, explicit action. Drafts must survive navigation. MCP task_create accepts structured Markdown and labels and only saves ordinary tasks. task_start marks an ordinary task in progress; the calling agent implements it in the same conversation and workspace. Explicit saved-team assignments retain their team routing. Tasks have no Agent tab: Open thread returns to their conversation or creates an unstarted thread for an unlinked task. Threads remain continuable and have no Done state.

Plan mode investigates and proposes. The other modes (Review everything, Accept edits, and Autonomous; Codex calls them Review changes, Ask for approval, and Full access) permit carrying out the user's intended action. Capturing a task means saving its document; it does not authorize implementing its contents. An implementation request continues in the current thread; delegation requires an explicit request for separate agents or a saved team. Requests for investigation or a plan remain investigation or planning in every mode. The agent uses the request and conversation context to choose the action, rather than treating the mode as an instruction to start every task.

Tasks also own a Comments section independently of threads. User mentions select a model and effort; Reply retains visible recipients, while untagged notes stay inert. Several tagged models may answer independently. Description mentions run only through Ask tagged agents after saving. Discussion uses read-only runs, without changing task status or creating a thread. An explicit implementation request hands work to one selected agent in the task's linked thread, preserving execution permissions and workspace rules, and returns the result to comments. Ambiguous intent gets a clarifying reply. Agent output never wakes another agent automatically.

Reply resumes the addressed model and effort's existing discussion session, including after an app restart. Replies to a user comment resume each matching recipient independently. New comments and changed recipients start separate sessions. When no session is available, persisted comment context seeds a new one; a provider-reported lost session requires an explicit Retry to rebuild it. Execution sessions remain separate from discussion.

Tasks started from a thread show their latest commentary, recent actions, and requests for input in that thread. The parent agent can read the same progress through task_get. Final reports persist independently of the parent provider, including failures and results arriving in Plan mode.

## Product principles

- Preserve user work across navigation, failures, and provider changes.
- Separate describing work from authorizing its execution.
- Make state and recovery visible where the work happens.
- Validate feature usefulness with reproducible evidence.
