# Visual explanations in conversations

Agents can use OpenOrc's `visualize` tool to explain a concept with a diagram, chart, or small interactive example. Ask things like “Show me how a queue works” or “Let me step through binary search.” The agent can also choose a visual when it would make an explanation clearer.

Visualizations appear alongside the reply, including when work details are collapsed. **Hide visualization** closes the view, **Show visualization** reopens it, and **Reset** restores the initial state. **View source** exposes the original tool call. The title and plain-text explanation remain readable if the view cannot load.

The tool is available to agents connected to OpenOrc's internal MCP server, including Codex, Claude Code and OpenCode. It works in Plan conversations too. The HTML is saved as part of the tool input, so reopening history does not require a live provider session. Control values are local to an open view; resetting, hiding or reopening history starts from the original HTML.

## Tool input

`visualize` takes three strings:

- `title`: a short title, up to 120 characters.
- `description`: a plain-text explanation, up to 2,000 characters.
- `html`: a self-contained HTML fragment, up to 256,000 characters, with inline CSS, SVG and optional JavaScript.

Use native labeled controls and inline SVG or canvas for diagrams and charts. External scripts, styles, images and network APIs are blocked. The frame has no file, Electron, agent or tool access. It uses the same separate-origin, opaque inner sandbox as MCP Apps, with no network domains granted.

The host supplies `--background`, `--foreground`, `--muted`, `--border`, `--accent`, and `--surface` CSS variables, updates them with the conversation's theme, and styles basic native controls. Build for widths down to 320px, keep text legible, and provide a useful initial state. The frame sizes to its contents up to 1,200px high; compact explanations work best. Respect reduced motion when using JavaScript animation.

```json
{
  "title": "First in, first out",
  "description": "A queue removes items in the order they arrived. Click Next to remove the first item.",
  "html": "<ol id='queue'><li>First</li><li>Second</li><li>Third</li></ol><button type='button' id='next'>Next</button><p id='status' aria-live='polite'></p><script>document.getElementById('next').onclick=()=>{const item=document.querySelector('#queue li');document.getElementById('status').textContent=item?'Removed '+item.textContent:'The queue is empty';item?.remove();};</script>"
}
```

## Verification

```sh
pnpm --filter @openorc/mcp test
pnpm --filter @openorc/desktop exec vitest run src/renderer/src/lib/visualization.test.ts src/renderer/src/components/VisualizationResult.test.tsx
node scripts/visualization-ui-smoke.cjs
```

The Chromium check uses the production transcript and sandbox with synthetic content, checks local interaction, history, themes, narrow layouts and isolation, and saves screenshots to a temporary folder.
