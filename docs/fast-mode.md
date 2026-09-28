# Fast mode

Fast asks a provider for its faster service tier, at a higher usage cost. It is separate from reasoning effort and never changes the selected model. Toggle the lightning icon in the composer's model and effort popover; the lightning beside the model shows the current setting. When the model list says the model or account cannot serve Fast, the lightning and toggle turn amber and the popover shows the reason. The setting stays on so you can turn it off, and new turns are refused until you do or access returns.

## Behavior

- New conversations start on Standard. The setting applies only to the agent processes OpenOrc starts; it does not change your global CLI preferences.
- The conversation stores the setting for its next turn, and each run records what it actually requested. Changing model, effort or Fast between turns does not restart the agent: the next message applies the change to the open session and posts a notice in the conversation. Fast is checked against the account and model first. If the provider refuses the change, or effort is reset to the default, OpenOrc resumes the session with the new settings instead.
- Forks and tasks started from a conversation keep its Fast setting. Switching to another provider, or to a model without Fast, turns Fast off; choosing that model again does not turn it back on.
- Changing or resetting effort leaves Fast unchanged, and changing Fast does not lower effort.
- OpenOrc checks eligibility again before replacing a session or starting a turn. A refused queued message stays available to retry.

When a model has no Fast information yet, the popover shows "Fast mode availability was not reported. Try Refresh models." instead of calling the model unsupported. Reopening the model picker loads its model data again, so an earlier loading or discovery failure does not stick.

## Providers

**Codex:** Fast is offered for models whose `model/list` entry lists the `priority` service tier (shown as Fast), or the older `additionalSpeedTiers: ["fast"]`. OpenOrc sets `serviceTier` when a thread starts, resumes or forks and on every turn, sets `service_tier` in the process configuration, and turns on Codex's Fast feature for runs that ask for it. Standard sends `default` explicitly, so an inherited Fast setting does not apply. Last verified against `codex-cli` 0.154.0.

**Claude Code:** OpenOrc passes `--settings '{"fastMode":true}'`, or `false` for Standard, including when resuming. Live model discovery offers Fast on the models Claude Code marks as supporting it. If live discovery fails, or for older models the CLI no longer lists, OpenOrc uses its own list, which requires Claude Code 2.1.219 or newer for every Fast model. Fast is off when `CLAUDE_CODE_DISABLE_FAST_MODE=1` is set or when Claude Code uses Bedrock, Vertex or Foundry (`CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_USE_FOUNDRY`). On a Claude subscription, Fast bills to usage credits.

Model discovery asks Claude Code for Fast without running anything, so its answer includes the account's reason when Fast is off. A definite reason, such as usage credits being off, the plan, the organization, the environment, or a failed network check, marks Fast unavailable on every Claude model with that reason. A pending check does not, and neither does `model_not_allowed`, because Claude Code checks that against its default model rather than each model. During a run that asked for Fast, OpenOrc posts a notice when Claude answers at standard speed (Fast turned off, or a rate-limit cooldown) and when Fast comes back. Claude Code's own out-of-credits message is shown as is.

References: [Codex speed](https://learn.chatgpt.com/docs/agent-configuration/speed), [Codex app-server](https://learn.chatgpt.com/docs/app-server), [Claude Fast mode](https://code.claude.com/docs/en/fast-mode).

## For contributors

Recheck the provider documentation before changing model eligibility or minimum versions.

Between turns, setting changes reach the open session through Claude's `set_model` and `apply_flag_settings` (`effortLevel`, `fastMode`), Codex's `model`, `effort` and `serviceTier` on `turn/start`, and OpenCode's `session/set_config_option` for model and effort.

Provider transport tests check explicit on and off settings and that model and effort are kept. Core integration tests cover eligibility, database defaults, RPC persistence, forks, and queued-turn changes with mocked agents. Agent and core unit tests cover the account reason from discovery and the run notices, and `scripts/fast-mode-effects-smoke.cjs` covers the amber state. None of these checks need paid inference.

Renderer hot reload does not restart the core process. After changing backend code or the database schema, restart OpenOrc once current turns have finished.
