# Task descriptions

New tasks and a task's Overview use a rich document editor. It supports headings, inline formatting, links, lists, nested checklists, quotes, code, dividers, and images. Select text to format it, or use the insert button or type `/` at the start of a paragraph to search commands. Arrow keys move through the results, Enter inserts, and Escape closes the menu and keeps what you typed. Slash commands do not open inside code or file paths.

## Images

Paste images from the clipboard, drop image files where you want them, or use `/image`. PNG, JPEG, GIF, and WebP images are accepted up to 20 MB, 40 megapixels, and 16,384 pixels per side. An added image gets a line of its own, and writing continues below it. Select an image to view it large, describe it, replace it, or remove it. Images referenced by a path on this computer, absolute or relative to the project, show as well.

Images are saved in the background. Creating a task, saving, or leaving the page waits for them to finish, and autosave pauses while any are pending. A failed image stays in the document with **Retry** and **Remove**. A text draft that fails to save is shown as unsaved rather than reported as saved. Retrying, navigating, reloading, and undo or redo can recover an image that was still saving.

Removing an image from a document does not delete its file, because another draft or earlier run may still refer to it.

## Markdown

Task descriptions are stored as Markdown. Every description opens in rich text, and opening one never rewrites it: only edits are saved. Markdown with no rich form, such as raw HTML, `$$` math, footnotes, and images inside links, is kept exactly as written and shows as plain source you can edit in place. **Markdown** shows the whole source, and **Rich text** returns. Block dragging, image resizing and captions, advanced table editing, and shared editing are not supported.

## Refine

**Refine**, beside **Markdown**, asks an agent to improve the task. Its sheet takes what should change, which is optional, and the model or Orcling to use. A Claude model also takes the account to refine on, from the ones the project uses; an Orcling keeps its own. The sheet remembers both for next time. The task's latest edits are saved first. The agent works read-only: it reads the project and the task's comments, and its only tool, `task_suggest`, hands back a suggested title, description and labels with a one-line note. Nobody can answer the agent during a Refine, so a question it would ask goes under Open questions in the suggestion. It reads the task thread's worktree, or the project folder once that worktree is gone.

While it works, a bar takes the controls' place, naming the agent and its latest step, with **Stop**. The document stays editable. When the suggestion arrives, it shows in place of the document: added blocks have a line in the margin, changed words are shaded, removed text folds behind **Show removed text**, and a changed title shows the old one struck through above it. **Use suggestion** applies it as an ordinary edit, which autosave keeps and, in rich text, ⌘Z in the description undoes. **Dismiss** puts it away, and **Refine again** asks for another, continuing the same agent session when the model and account are the same and the task hasn't changed since; otherwise it starts again from the task as it is now. **Edit** turns the suggestion's title, description and labels into fields to change before using it, and **Show changes** goes back to the marked view with those edits in it. The edits are kept with the suggestion, so they survive leaving the page, and **Use suggestion** applies the edited version. **Refine again** after editing starts from your edited version: the agent keeps your edits unless what you ask now changes them. If you edit the task while the agent works, the suggestion says it was made from an earlier version.

A suggestion survives leaving the page and restarting. Tasks on OpenOrc Cloud don't offer Refine yet.

## Images when a task runs

Before a task run starts, OpenOrc checks every image in its description, including reference-style Markdown images but not images inside code examples. A missing, invalid, or still-saving image stops the run before it is created.

- **Ordinary task runs:** the task's images are listed as file paths, in document order, in the prompt. This works the same way for every provider. Images you attach in the composer are sent separately as attachments.

Images on the web are not loaded, so opening a description never contacts their server. They show where they point, with an action to open them in the browser. They are not downloaded or sent to the agent.

## For contributors

Images are held in IndexedDB until the core writes the file. While saving, the Markdown stores an import ID, which becomes a managed `openorc-asset://attachments/...` URL once the file exists. Image validation runs in the core as well as the renderer. Task routes load the editor lazily, so ordinary conversations do not load it, and the editor dependencies are pinned.

- `apps/desktop/src/renderer/src/components/editor/document-schema.test.ts`: Markdown compatibility and slash-command matching.
- `packages/core/src/services/attachments.test.ts`: image validation, pending, missing and path-escaping references, and symlink escapes.
- `packages/core/src/services/task-images.test.ts`: Codex and Claude task starts through `tasks.start` and `runs.start`; task images are listed in the prompt and composer attachments stay separate.
- `packages/core/src/services/task-refine.test.ts` and `apps/desktop/src/renderer/src/components/task-refine/`: Refine's read-only run, its suggestion, and how the suggestion is shown and used.
- `node scripts/task-editor-ui-smoke.cjs`: an isolated Electron profile covering clipboard paste, image insertion, reload recovery, failed saves and retry, deletion while saving, formatting, Markdown paste, undo and redo, source preservation, and light, dark and narrow layouts. It makes no paid agent calls.
