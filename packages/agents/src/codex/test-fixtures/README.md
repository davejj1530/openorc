# Native subagent stream

Recorded from Codex app-server 0.166.0 with `gpt-6-luna`, low effort, on 2026-11-03. Two children run short shell sleeps and return alpha/beta. The first child's turn was interrupted while the parent and sibling were active. The sibling and parent completed normally. IDs and local paths are replaced; encrypted content is excluded.

The CLI emits `subAgentActivity` launches, child turn notifications, and collaboration wait items. It does not emit child `thread/started` notifications in this run. Separate history reads provide lineage and nicknames. V2 task assignments are encrypted agent messages and are absent from `thread/items/list`, so this fixture intentionally has no child prompt.
