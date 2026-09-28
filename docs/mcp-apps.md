# Interactive MCP Apps

OpenOrc can show the interactive views that some MCP servers provide with their tool results, called MCP Apps. A compatible tool declares `_meta.ui.resourceUri` (or the older `ui/resourceUri` key). The provider reads that `ui://` resource, and OpenOrc passes the original tool arguments and result to the view through the official `AppBridge` SDK.

## Provider support

- **Codex:** supported. OpenOrc uses the existing Codex connection for tool discovery, resource reads, and tool calls made by the app. Last verified against the `codex-cli` 0.154.0 app-server protocol.
- **Claude Code and OpenCode:** OpenOrc does not host MCP Apps for these providers. Their tool results show as usual.

When an app cannot load, the regular tool result stays available.

## Reopening an app

Apps from new Codex tool calls keep their source and context in the conversation history. An app can be reopened while the Codex session that produced it is still running; after that session closes, the saved result is shown instead. OpenOrc does not restart agents, recover sign-in tokens, or start a second sign-in to reopen an app.

## What apps can do

Apps render inline and receive tool input and results (including `structuredContent` and `_meta`). They can call tools, read resources, open web links through OpenOrc's usual link handling, resize themselves, and read the theme, locale and time zone. Normal results stay in the expandable tool details.

An app can call only tools from its own server (and, for connector aggregators, its own connector), and each call goes through the conversation's usual permission rules. Apps cannot open in Plan conversations. Closing an app cancels any approval it is waiting for; tool calls are never retried automatically.

Not supported: chat messages, model-context updates, sampling, downloads, full screen or picture-in-picture, clipboard access, and device permissions. An app may declare HTTPS hosts it needs (wildcard subdomains are allowed); undeclared connections, `eval`, workers, forms and top-level navigation are blocked. An app that declares a local host (`localhost`, `.local`, or an IP address) is refused and does not load. OpenOrc never grants an app more than it declares.

## For contributors

`McpAppConnection` is the small authenticated interface a provider implements. `McpAppService` finds the saved tool call that produced the app and grants the view a revocable scope limited to that server and, for aggregators, that connector.

The renderer loads `@modelcontextprotocol/ext-apps` 1.7.5 (compatible with the repository's MCP SDK 1.x) only when an app view opens. It talks only to its exact proxy frame. A separate local HTTP origin serves the proxy and the inner frame; the inner frame has an opaque sandbox origin, no Electron preload, and a content security policy enforced by HTTP headers. The server checks the Host header and a random token per view, serves only registered documents, and drops them when the owning window reloads or closes. The core accepts setup messages only from the host window itself.

```sh
pnpm --filter @openorc/agents exec vitest run src/codex/mcp-apps.test.ts src/codex/adapter.test.ts src/tool-results.test.ts
pnpm --filter @openorc/core exec vitest run src/mcp-apps-rpc.test.ts src/services/mcp-apps.test.ts src/services/permissions.test.ts
pnpm --filter @openorc/desktop exec vitest run
pnpm --filter @openorc/desktop typecheck
pnpm --filter @openorc/core typecheck
pnpm --filter @openorc/agents typecheck
node scripts/mcp-apps-ui-smoke.cjs
```

The Chromium smoke uses the production transcript, AppBridge, core app service and sandbox. Gallery and weather fixtures check compatibility, tool routing, refusal of other servers' tools, isolation, blocked network requests, sizing, theme changes, close and reopen, and fallbacks. To check Mobbin's real interface without committing account data or vendor assets, point `OPENORC_MOBBIN_RESOURCE` and `OPENORC_MOBBIN_RESULT` at locally captured resource-read and read-only search responses. Screenshots go to the smoke's temporary folder.

References: [MCP Apps specification](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx), [official reference host](https://github.com/modelcontextprotocol/ext-apps/tree/main/examples/basic-host), [Mobbin MCP features](https://docs.mobbin.com/mcp/features). Codex methods were checked against `codex app-server generate-ts` output rather than assumed.
