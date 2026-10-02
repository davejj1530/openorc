# Orclings

An Orcling is a long-term companion: a saved identity with its own look, name, model, permission, instructions and memory. It is the same Orcling wherever it works, and one conversation of its own holds everything you say to it directly.

## What an Orcling is

- **Identity.** Stored in `orclings`: name, look, harness and model, and permission. Names are unique, ignoring case and punctuation (`orclingHandle`). Each Orcling owns one conversation in the Workspace, working in a folder named after it under the app's data directory, such as `orclings/rini`. Renaming it moves that folder between turns, and its next turn starts a fresh session there from a summary; a folder you choose for its conversation yourself never moves. Deleting the Orcling removes that conversation, its instructions and its memories; files it made in its folder stay.
- **Instructions.** Its own prompt, kept in `orcling_instructions` as numbered versions. The Orcling rewrites them with `orcling_instructions_update`; you edit or restore any version in its profile. Restoring saves the old text as the newest version, so no change is ever lost.
- **Memory.** Rows in `memories` owned by the Orcling (`orcling_id`, scope `orcling`), never tied to a project and left out of every project search. The Orcling saves with `orcling_remember` and searches with `orcling_recall`. After each process of its own conversation ends, memory extraction distills what it learned about you into this memory.
- **Look.** Shape, eyes, texture, glasses, accessory, body and eye colors. `assets/mascot/orcling.riv` draws it live; `OrclingAvatar` draws a flat version for lists and bylines.

## One identity, many places

Every run records who spoke in `runs.orcling_id`; a thread records the Orcling working in it in `threads.orcling_id`. Whenever a process starts, its system prompt carries the Orcling's brief: who it is, where it is, its current instructions and its memory. That happens in:

| Place                  | How the Orcling joins                                                                                                                                    |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Its own conversation   | Always the Orcling. Changing the model there changes the Orcling's model.                                                                                |
| A new project thread   | Chosen in the model picker (`ExecutionTarget` kind `orcling`), or started by the Orcling with `orcling_thread_start`. A plain model later takes it back. |
| Any other conversation | `@Name` in a message asks it as a guest. It answers in that thread; the thread's own agent keeps its session and hears the answer next turn.             |
| Task comments          | Mentioned by name. It replies read-only like any comment reply; work it agrees to runs as the Orcling in a thread made for the task.                     |
| Pull request reviews   | Chosen as the reviewer. Its draft comments are named after it and the model it ran on (`author_orcling_id`).                                             |
| Teams                  | A member seat can be an Orcling, recorded in `orcling_seats`. The seat always carries the Orcling's current name, face, model, effort and Fast mode.     |
| Slack                  | The Slack conversation can hand itself to an Orcling with `execution_switch` and `orclingId`; later replies in that Slack thread stay with it.           |

Sessions are keyed by thread, harness and speaker, so a guest never resumes the thread agent's session or the other way round. Anyone who starts a process in a thread where others spoke since hears what they said.

## Sessions that roll over

An Orcling's own conversation reads as one endless thread, but its provider session does not have to last forever. The next message starts a fresh session when the last turn ended more than six hours ago, or when the session has used 70% of the model's context window. The fresh session starts from the Orcling's brief, summaries of earlier sessions, and the most recent messages. `orcling_history` searches everything ever said in its conversations.

## Permission

An Orcling's permission is **Approve** (Review everything: it asks before every command or edit) or **Allow** (Autonomous). OpenCode cannot ask before each command, so an OpenCode Orcling on Approve works read-only; on Allow it changes things like any other. The permission is a ceiling: wherever the Orcling works, the stricter of its permission and the place's own rule applies. Task comment replies stay read-only, and a thread given to an Approve Orcling cannot be set looser. Tool-level rules are in [permissions for OpenOrc's own tools](internal-app-permissions.md).

## Its model is part of who it is

An Orcling brings its own model, effort and Fast mode wherever it works, including a team seat or the team lead, where its name and face stand in for the member's. A team cannot change any of them; edit the Orcling to change them everywhere at once.

## Its own conversation is a private chat

Its own conversation lives in the Workspace but is not Workspace work. Its prompt carries its brief and a line about its folder, and no project's memory or task rules: anything they held would read as its own history. The general task, thread and memory tools are left out there too (`ownConversation` in `orcling-tools.ts`), since they point at the Workspace; its own tools stand in for them. Summaries of its conversation feed its own fresh sessions and never appear in the Workspace's memory, and the Workspace's recent threads leave Orclings' conversations out. In a project thread, as a guest, or on a team, it works on that project, so that project's memory comes with it as it does for any agent.

## Reaching your projects

From anywhere, an Orcling can list your Workspace and projects (`orcling_projects`), see one at a glance with its open tasks, recent threads and memory (`orcling_project`), read any thread (`orcling_thread_read`), save a backlog task (`orcling_task_create`), start work in a project (`orcling_thread_start`) and message a thread (`orcling_thread_send`). Starting work opens a new project thread where the Orcling works itself, from a prompt or a saved task. The thread opens with a notice naming who started it, and the chat that asked shows a card that opens it. What it finds there is that place's record, not its own memory. Code changes happen in project threads, not from its own conversation.

## Code map

- Protocol: `packages/protocol/src/orclings.ts`.
- Storage: `packages/db/src/orcling-schema.ts`, `packages/db/src/orclings.ts`, and the Orcling queries in `memories.ts`.
- Behavior: `packages/core/src/services/orclings.ts` (identity, permission ceiling, rollover) and `orcling-briefs.ts` (prompt text).
- Tools: `packages/mcp/src/orcling-tools.ts` and `packages/core/src/mcp-host/orcling.ts`.
- Interface: `views/OrclingDesigner.tsx`, `panels/OrclingPanel.tsx`, `components/SidebarOrclings.tsx`, `components/useOrclingConversation.tsx`.
