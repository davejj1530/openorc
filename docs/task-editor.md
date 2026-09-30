# Task descriptions

New tasks and a task's Overview use a rich document editor. It supports headings, inline formatting, links, lists, nested checklists, quotes, code, dividers, and images. Select text to format it, or use the insert button or type `/` at the start of a paragraph to search commands. Arrow keys move through the results, Enter inserts, and Escape closes the menu and keeps what you typed. Slash commands do not open inside code or file paths.

## Images

Paste images from the clipboard, drop image files where you want them, or use `/image`. PNG, JPEG, GIF, and WebP images are accepted up to 20 MB, 40 megapixels, and 16,384 pixels per side. An added image gets a line of its own, and writing continues below it. Select an image to view it large, describe it, replace it, or remove it. Images referenced by a path on this computer, absolute or relative to the project, show as well.

Images are saved in the background. Creating a task, saving, or leaving the page waits for them to finish, and autosave pauses while any are pending. A failed image stays in the document with **Retry** and **Remove**. A text draft that fails to save is shown as unsaved rather than reported as saved. Retrying, navigating, reloading, and undo or redo can recover an image that was still saving.

Removing an image from a document does not delete its file, because another draft or earlier run may still refer to it.

## Markdown

Task descriptions are stored as Markdown. Every description opens in rich text, and opening one never rewrites it: only edits are saved. Markdown with no rich form, such as raw HTML, `$$` math, footnotes, and images inside links, is kept exactly as written and shows as plain source you can edit in place. **Markdown** shows the whole source, and **Rich text** returns. Block dragging, image resizing and captions, advanced table editing, and shared editing are not supported.

## Images when a task runs

Before a task run starts, OpenOrc checks every image in its description, including reference-style Markdown images but not images inside code examples. A missing, invalid, or still-saving image stops the run before it is created.

- **Ordinary task runs:** the task's images are listed as file paths, in document order, in the prompt. This works the same way for every provider. Images you attach in the composer are sent separately as attachments.
- **Team runs:** the task's images are attached to the member's turn.

Images on the web are not loaded, so opening a description never contacts their server. They show where they point, with an action to open them in the browser. They are not downloaded or sent to the agent.

## For contributors

Images are held in IndexedDB until the core writes the file. While saving, the Markdown stores an import ID, which becomes a managed `openorc-asset://attachments/...` URL once the file exists. Image validation runs in the core as well as the renderer. Task routes load the editor lazily, so ordinary conversations do not load it, and the editor dependencies are pinned.

- `apps/desktop/src/renderer/src/components/editor/document-schema.test.ts`: Markdown compatibility and slash-command matching.
- `packages/core/src/services/attachments.test.ts`: image validation, pending, missing and path-escaping references, and symlink escapes.
- `packages/core/src/services/task-images.test.ts`: Codex and Claude task starts through `tasks.start` and `runs.start`; task images are listed in the prompt and composer attachments stay separate.
- `node scripts/task-editor-ui-smoke.cjs`: an isolated Electron profile covering clipboard paste, image insertion, reload recovery, failed saves and retry, deletion while saving, formatting, Markdown paste, undo and redo, source preservation, and light, dark and narrow layouts. It makes no paid agent calls.
