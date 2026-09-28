# OpenRouter in teams

Teams are in Beta and enabled for new profiles. Manage **Team execution (Beta)** in Settings → General → Orchestration; existing on/off choices are preserved.

OpenRouter models join a team through OpenCode, with model IDs such as `openrouter/<provider>/<model>`. They can be leads, managers or workers alongside Codex and Claude Code. In the team editor, pick the model from OpenCode's OpenRouter provider group.

## Requirements

- OpenCode must be installed and signed in to the provider that offers the selected model. **Check readiness** names any member whose model is unavailable and keeps that member's saved choice.
- Teams with OpenCode members must use **Plan** or **Autonomous**. OpenCode refuses to start in **Review everything** or **Accept edits**, because this integration cannot guarantee approval before every command. The same applies to ordinary OpenCode conversations. OpenOrc does not change a team's mode for you.
- OpenCode members cannot take messages during a turn; see [team corrections during active work](team-live-steering.md).

## For contributors

- A database test goes through every registered agent, so adding one cannot leave team storage behind.
- An upgrade test starts from a populated older database and checks that a three-level team, its pinned conversation, avatars and member rows survive, along with new OpenRouter revisions, reopening, project deletion and database integrity.
- Service tests save and reopen mixed teams, check readiness through OpenCode, and keep a saved model when it disappears from the catalog.
- Core tests use real storage, RPC, MCP and Git with scripted providers: OpenRouter leads and members exchange messages with Codex and Claude, reuse sessions, delegate isolated work, hand over uncommitted changes and merge the resulting files.

```sh
pnpm --filter @openorc/db exec vitest run
pnpm --filter @openorc/core exec vitest run src/services/orchestration.test.ts src/team-chat-rpc.test.ts src/team-runtime-routing.test.ts
pnpm --filter @openorc/db --filter @openorc/core typecheck
```
