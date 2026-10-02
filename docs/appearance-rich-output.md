# Appearance and rich thread output

Settings → Appearance offers the OpenOrc, Codex, Conductor, Linear, Cursor, Claude, GitHub, Halcyon, Kamakura, ClickUp, Cyberpunk, Notion, and Eliron palettes. The product-named palettes adapt documented or shipped colors from those products. Light, dark, and system appearance are chosen separately from the palette. Your choices are saved in local storage (`openorc.theme` and `openorc.palette`) and apply to every open window. An unknown saved palette falls back to OpenOrc. If saving fails, the selected appearance stays active for the session and Settings explains why.

Messages, task reports, and task description previews share one Markdown renderer. It supports syntax highlighting, copying and downloading code, tables with copy, export and full-screen controls, checklists, quotes, KaTeX math, and Mermaid diagrams. Math uses double-dollar delimiters (`$$…$$`), so prices with a dollar sign are not read as math. Mermaid loads only when a message contains a diagram code block and renders in strict mode. If it cannot load, the diagram source stays readable with a short explanation.

The dividers beside the sidebar and review panel can be dragged, or moved with the keyboard: arrow keys move 8px, Shift+arrow 32px, Home and End jump to the limits, and Enter or a double-click resets. Cancelling a drag restores the previous size.

## Links and images in threads

- **Web links** open in this conversation's Preview sidebar, or in your default browser where no Preview is available. Right-click a link to choose where it opens, including **Open in default browser** and, when Chrome is installed, **Open in Chrome Incognito**, or to **Copy link address**.
- **Local file links** open the file viewer in thread and task conversations, at the cited line when there is one. Elsewhere they show the file in its folder.
- **Local image links**, Markdown images, generated images and your own attachments open an image viewer with fit, zoom, the image's dimensions, and a button that shows the file in its folder.

Relative paths resolve against the thread or task worktree, or the project root. Image-generation activity saved by earlier versions still replays.

Images are served only for supported image types, up to 32 MB each, under a restrictive content security policy. Moved, missing or unreadable images show as unavailable. Remote image URLs, and provider results that have no saved file, are not fetched as local previews.

## Custom colors

Palettes are starting points. Settings → Appearance → **Colors** exposes nineteen colors in four groups (mascot, surfaces, text and lines, accent), each with a color picker and a hex field.

Each change belongs to one palette and one appearance mode, so light and dark keep their own values and switching palettes shows that palette's own changes. Changes are saved in local storage under `openorc.colors` as `{ palette: { mode: { token: hex } } }`. Values that are not six-digit hex, unknown color names, and palettes that no longer exist are ignored when read, so a hand edit or an older version cannot break startup. Each changed row has a reset button, and **Reset all** clears the current mode. Palette cards preview their own changes.

Built-in palette colors can include transparency, which the color picker cannot show. Editing such a color makes it opaque.

## For contributors

Palette values and their body and sidebar assignments live in [theme-palettes.ts](../apps/desktop/src/renderer/src/lib/theme-palettes.ts). Keep the named roles and check readability in both modes when changing them. A palette may also set the success and attention colors (`--ok`, `--warn` and their soft fills); any it leaves out keep the app's own. Palette values are written as `lch()`, `color-mix()` and eight-digit hex, none of which `<input type="color">` accepts; `lib/color.ts` converts them by painting one pixel and reading it back.

Rendering uses Streamdown 2 with its code, math, and Mermaid plugins. See the Streamdown [usage](https://streamdown.ai/docs/usage), [Mermaid plugin](https://streamdown.ai/docs/plugins/mermaid), and [math plugin](https://streamdown.ai/docs/plugins/math) documentation.
