# Product model

OpenOrc is an Electron desktop workspace for developers using installed coding-agent tools, with an iPhone app that pairs with it. Conversations, task documents, changes, and project context stay together across local repositories. OpenOrc stores its data on your machine, while each agent sends its requests to its own model provider.

## Conversations and work

Threads are durable conversations. Tasks describe bounded work, can belong to a thread, and execute in the configured local checkout or an explicitly selected isolated git worktree. Runs use the vendor CLIs. The local SQLite ledger feeds project memory. No OpenOrc account is required.

A new thread's heading asks what to work on in the current project, and the project's name in it switches projects or adds one. The sidebar lists threads by when they last worked: Recent (the last three hours), Today, and Yesterday, with pinned and snoozed threads in groups of their own. A thread quiet since before yesterday, or one you resolve, moves to the Resolved drawer at the foot of the sidebar. Resolving changes nothing else. Sending to a resolved thread, implementing its plan, or starting task work in it reopens it.

Threads nest. A helper thread that an agent starts with `thread_start`, and a subthread you start from a thread's menu, work in the parent's folder and sit under it in the sidebar. Subagents that an agent runs on its own, such as Claude Code subagents and workflows, Codex collaboration agents, and OpenCode child sessions, become read-only child threads with a card in the parent's transcript.

Each Claude thread runs on one of your Claude Code accounts. Between turns, the thread header's account menu moves the conversation to another account, where the next message resumes a copy of its session. When a run stops on a usage limit, the conversation offers the other signed-in accounts.

Workspace holds direct chats and new Slack conversations independently of imported projects. Each conversation keeps its own working folder, which need not be a Git repository. Choosing a folder for a new direct chat changes only its draft; Settings → Slack → Workspace entrypoint changes the shared default for new conversations and Slack folder discovery. Existing conversations retain their folders when that default changes. Background Slack arrivals refresh the thread list without navigating the desktop. Managed Git worktree, checkpoint, commit and PR controls remain in project conversations. Setup and routing details live in [docs/slack.md](docs/slack.md). Slack setup defaults to a personal bot connected directly from the desktop over Socket Mode, with a guided app manifest and local owner binding. Each user supplies their own Slack app; no hosted relay is required. A shared relay is available as an advanced connection type.

Orclings are long-term companions. The Orclings button at the foot of the sidebar switches its list between threads and Orclings. You design each one's look and choose its model, Claude account, and permission (Approve or Allow). An Orcling keeps one conversation of its own, its own instructions that it can rewrite, and a memory about you that no project sees. It can also work in project threads, answer when mentioned in any conversation or task comment, review pull requests, and pick up work handed over from Slack; it never works more freely than its permission allows. See [docs/orclings.md](docs/orclings.md).

Tasks open in a full-page document editor and save to backlog by default, whether created by the user or through MCP. Starting an agent is a separate, explicit action. Drafts must survive navigation. MCP task_create accepts structured Markdown and labels and only saves ordinary tasks. task_start marks an ordinary task in progress; the calling agent implements it in the same conversation and workspace. Tasks have no Agent tab: Open thread returns to their conversation or creates an unstarted thread for an unlinked task. Threads remain continuable and have no Done state; Resolved only files them away.

Plan mode investigates and proposes. The other modes (Review everything, Accept edits, and Autonomous; Codex calls them Review changes, Ask for approval, and Full access) permit carrying out the user's intended action. Capturing a task means saving its document; it does not authorize implementing its contents. An implementation request continues in the current thread; delegation requires an explicit request for separate agents. Requests for investigation or a plan remain investigation or planning in every mode. The agent uses the request and conversation context to choose the action, rather than treating the mode as an instruction to start every task.

Tasks also own a Comments section independently of threads. User mentions select a model and effort; Reply retains visible recipients, while untagged notes stay inert. Several tagged models may answer independently. Description mentions run only through Ask tagged agents after saving. Discussion uses read-only runs, without changing task status or creating a thread. An explicit implementation request hands work to one selected agent in the task's linked thread, preserving execution permissions and workspace rules, and returns the result to comments. Ambiguous intent gets a clarifying reply. Agent output never wakes another agent automatically.

Reply resumes the addressed model and effort's existing discussion session, including after an app restart. Replies to a user comment resume each matching recipient independently. New comments and changed recipients start separate sessions. When no session is available, persisted comment context seeds a new one; a provider-reported lost session requires an explicit Retry to rebuild it. Execution sessions remain separate from discussion.

Tasks started from a thread show their latest commentary, recent actions, and requests for input in that thread. The parent agent can read the same progress through task_get. Final reports persist independently of the parent provider, including failures and results arriving in Plan mode.

## Beside the conversation

A panel docked on either side of the conversation holds its tools: Changes, Files, Terminal, Preview, Commits, Checkpoints, the plan, tasks, memory, instructions, and Device. Files open in an editor with TypeScript code intelligence, and saving writes to the conversation's folder. A code file's menu also explains it as Plain English, a Walkthrough, or a Diagram. Plain English gives each statement its own note. A small model, chosen under Settings → Memory & models → Text generation, writes them, and OpenOrc caches them on disk. With Device support on, the Device tab shows an iOS Simulator or Android Emulator that you and agents with the `device` tool can drive.

## Away from the desktop

The iPhone app pairs with the desktop in Settings → Phone and talks to it directly over an encrypted link, on the local network or a tailnet. It reads and drives the same threads: live transcripts, approvals and questions, the composer, new threads, changes with commit, push and pull requests, tasks, and a live view of the Preview it can scroll, tap, and type into. A paired phone acts as the user, so pairing and the encrypted session are the boundary. On top of that, the desktop answers only the methods in its phone policy, and host paths, secrets, and phone access itself stay on the desktop.

A thread can also run in the cloud, in a sandbox on the user's Vercel or Agent37 account, with its changes synced back to a worktree on the desktop. A thread can move to the cloud and back between turns, and a setting moves working threads to the cloud when the computer sleeps. The optional cloud brain is a headless copy of OpenOrc in the same account. Each thread has one owner, the desktop or the brain, and the phone's Home lists both, so work continues from the phone while the computer is closed. Cloud threads, moves, and the brain work for Claude Code, Codex, and OpenCode alike.

## Product principles

- Preserve user work across navigation, failures, and provider changes.
- Separate describing work from authorizing its execution.
- Make state and recovery visible where the work happens.
- Validate feature usefulness with reproducible evidence.
- Build each feature for every agent OpenOrc runs, through one per-agent interface, not for one provider first.
