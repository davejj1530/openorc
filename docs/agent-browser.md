# Agent access to the sidebar preview

Agents can use OpenOrc's `browser` tool to open and use websites in the conversation's Preview, in the right sidebar. Each agent session gets the tool and is told to use it first for local and public websites.

## Actions

| Action       | Parameters        | Result                                                                                                             |
| ------------ | ----------------- | ------------------------------------------------------------------------------------------------------------------ |
| `open`       | `url`             | Go to any HTTP or HTTPS website and return a snapshot.                                                             |
| `snapshot`   | None              | The page's text, up to 200 visible controls with element refs, and the viewport size, including open shadow roots. |
| `screenshot` | None              | A PNG of the visible area.                                                                                         |
| `click`      | `ref`             | Click an element and return the updated snapshot.                                                                  |
| `fill`       | `ref`, `text`     | Replace the value of an input, text area, select or editable text, and fire the usual input and change events.     |
| `press`      | `key`             | Enter, Tab, Escape, arrow keys, Backspace or Space on the focused control.                                         |
| `scroll`     | `y`, optional `x` | Scroll the page by CSS pixels and return a snapshot.                                                               |

Every snapshot replaces the previous element refs. Using an old ref, a removed control, or a covered target fails with a clear error. Snapshots leave out password values. The tool does not read inside iframes, upload files, click canvas coordinates, or run arbitrary page code.

Local, network, and public HTTP and HTTPS websites are allowed, including links, redirects and embedded frames. Other schemes and URLs with embedded credentials are refused (`about:blank` is reserved for the empty pane).

## Approvals

Reading is always allowed: `open`, `snapshot`, `screenshot` and `scroll` never ask. Actions that change a page follow the conversation's mode:

- `click`, `fill` and `press` are blocked in **Plan**, ask first in **Review everything** and **Accept edits**, and run without asking in **Autonomous**.
- Typing into a password field always asks, even in Autonomous, and is blocked in Plan.

**Allow for this run** covers later clicks, fills and key presses in the same run, but never password fields. See [permissions for OpenOrc's own tools](internal-app-permissions.md).

## Sign-ins

Every Preview uses one saved browser session (`persist:openorc-preview`), kept separate from OpenOrc's own app data. Sign-ins and cookies from your own browsing in Preview persist across launches, and agents use that same signed-in session. Sign out in Preview, or avoid signing in there, if an agent should not act on an account. Preview refuses all site permission requests (camera, notifications and so on) and blocks downloads.

## Which Preview an agent uses

- An agent only uses the Preview of its own conversation (or, for a task run, the task's conversation) during an active turn. It cannot choose another conversation, window, or target, or supply page code.
- Preview opens for an agent only when the window is showing that conversation. Work in the background keeps its own page, at 1000×720 until you open that conversation, when it takes the panel's size. No window needs to take focus.
- OpenOrc reuses an existing Preview, preferring a visible one in the focused window, and keeps it for that conversation until it closes. Another window keeps its own Preview.
- Page text and screenshots go only to the agent that asked for them.

## For contributors

- The agent's MCP connection identifies the run. The core requires an active turn and derives the Preview from the run's thread, or the owning thread of its task; standalone task runs use their task's Preview.
- The utility process talks to main over a private request and reply channel. Automation is not exposed through renderer RPC, and no remote-debugging port is opened. Main allows one action per conversation at a time and limits how long it can take.
- Snapshots and field edits run fixed code in the page's isolated context. Mouse and keyboard input use Electron's [Debugger transport](https://www.electronjs.org/docs/latest/api/debugger) on that page only, which avoids the focus requirement of [sendInputEvent](https://www.electronjs.org/docs/latest/api/web-contents#contentssendinputeventinputevent). A frame is captured before input so a new, hidden or resized view has current hit-testing.
- Screenshots use Chromium's page capture on the same view, including a background Preview that has never been shown.

```sh
pnpm exec tsx --test packages/mcp/src/index.test.ts
pnpm --filter @openorc/core exec vitest run src/browser-rpc.test.ts src/services/runs-orchestration.test.ts
pnpm --filter @openorc/desktop exec vitest run src/main/browser-pane.test.ts src/main/browser-bridge.test.ts src/core/browser-client.test.ts src/renderer/src/lib/browser-preview.test.tsx src/renderer/src/panels/BrowserPanel.test.ts
node scripts/browser-agent-smoke.cjs
```

The smoke builds the production browser modules and preload into a disposable folder, starts a real MCP server in a utility process, and drives a sandboxed Preview through the real bridge. It checks that the requested URL survives opening the sidebar, field edits, clicks, keyboard submission, scrolling, shadow roots, stale refs, screenshots, public hosts, links and redirects, cross-origin iframes, refusal of unsafe URLs, background use and capture, switching threads, recovery after closing the pane, and a second window. A test-only Chromium DNS rule points `preview.example.test` at the local fixture without changing system DNS. It saves a PNG and prints its path. The fixture makes no provider calls and uses no real user profile. Set `OPENORC_BROWSER_PUBLIC_URL=https://example.com/` to also load and capture a live public website.
