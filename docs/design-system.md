# Interface conventions

OpenOrc uses a neutral desktop shell, compact navigation, and spacious reading and editing columns. Shared components and semantic tokens keep conversations, task documents, and review panels consistent.

## Tokens and appearance

Color palettes are defined in `apps/desktop/src/renderer/src/lib/theme-palettes.ts` and applied by `lib/theme.ts`. Components use semantic variables from `app.css`: `--surface` for the main canvas, `--bg` for the sidebar, `--ink` roles for text, and separate action, link, border, and status roles. Every dark palette also sets `--surface-gradient`, an image painted over `--surface` on the work plane that runs from the palette's lighter ground at the top to a darker one at the bottom. Light planes stay flat. Sticky headers and other elements that must blend into the plane use the `well-fill` class rather than `bg-surface`. Light, dark, and system appearance are independent of palette selection. Verify both appearance modes and saved custom colors when changing a component.

Typography and radii use the shared `@theme static` tokens in `app.css`. The interface uses the system sans-serif stack; code uses JetBrains Mono with platform monospace fallbacks. Conversation prose uses `--text-prose`, composers use `--text-md`, and ordinary controls use `--text-base` or `--text-sm`. Long prose wraps; code and tables may scroll within their own containers.

Sidebar navigation uses 14px regular text; project names use 14px medium and thread titles use 13px regular. Imported projects use this icon priority: explicit choice, repository image, detected framework, detected language, outline folder. Workspace retains its globe. Click a project icon to select a discovered image, choose a local file, refresh candidates, or return to the folder. Discovery is a bounded local scan on first display, with positive and negative results stored under the app's `project-icons` data folder. It does not poll, watch repositories, execute project configuration, or call a network/model service. Manual selections survive refreshes; Automatic resumes discovery. Raster previews are at most 64px; small static SVGs stay vector images.

Framework/language fallbacks are 24 upstream Devicon brand SVGs shared through `ProjectStackIcon`: React, Next.js, NestJS, Vue, Nuxt, Svelte, Astro, Angular, Express, Laravel, Django, FastAPI, JavaScript, TypeScript, Python, Go, Rust, Java, C#, Ruby, PHP, Swift, C, and C++. These are an explicit exception to the app's original outline icon policy. Preserve the upstream shapes and colors; monochrome Express/Rust invert for dark appearance, while Astro/Django retain their colors on a light ground. Detection reads at most 256 root entries and five metadata files (64KB each); it does not walk source trees or dependency directories. It prefers specific frameworks over their dependencies, and leaves workspace roots or ambiguous stacks on the folder fallback. Plain projects can use root source extensions as a language hint. These logos ship once with the app; each project caches only an ID or a negative result. Refresh updates detection. Version-3 caches upgrade older automatic results once and preserve explicit choices.

The optional **Transparent surroundings** setting uses native blur on supported systems. Its **Transparency** slider ranges from 0% (solid palette tint) to 100% (native blur without a palette tint), defaulting to 35%. `.app-shell` paints this tint once behind the sidebar and outer rails through `--shell-opacity`; keep the main work planes, tool content, and expanded panels opaque. Preserve `--bg` as a solid palette color so gradients, previews, and custom colors continue to work. System Reduce Transparency takes precedence over the saved preference.

## Layout and controls

Repository headings offer **Remove project** through right-click or the options button. Removal only hides the repository from project lists and pickers: files, worktrees, history, running work, and schedules are retained. Importing it again restores the same project. Workspace cannot be removed.

The shell has a sidebar and a work row. The work row holds the main column and, in conversations and tasks, an optional tabbed side panel with tools such as changes, files, the terminal, and the browser. Each column owns its scrolling. Shared topbar dimensions and physical window-control clearance must survive zoom and sidebar changes. Resize handles support keyboard input as well as dragging.

Use the existing button, input, menu, dialog, and segmented-control primitives. Segmented selection uses text emphasis on a transparent background. Composer context and Git changes remain inside the composer shell, with the branch displayed once. Task creation and starting execution are separate actions, and save states reflect acknowledged persistence.

Recurring actions in task lists, schedules, and team toolbars use neutral icon buttons with accessible names and tooltips. Keep text buttons for form submissions, empty states, and decisions that need an explicit label. Reserve strong color for status, diff meaning, and destructive feedback rather than routine action fills.

Agent updates live in Settings → Connections: each agent shows its installed version and any available latest version, with explicit Update and Update all actions, a manual check, and an automatic-check toggle. Reuse shared buttons, badges, toggles, and Precision Outline icons; let agent rows and toolbars wrap at narrow widths. A dismissible notice in the upper-right workspace uses the same surface and text tokens, with Review updates leading to Connections so versions and update results stay together.

Responsive behavior follows available column width. Allow properties and toolbars to wrap; secondary labels may yield while accessible names remain. Check narrow windows, split conversations, enlarged text, keyboard focus, and reduced motion.

## Icons and motion

The [Precision Outline family](precision-outline-icons.md) uses original geometry on a 24-unit grid, 1.75-unit strokes, rounded caps and joins, and `currentColor`. Reuse the shared components rather than adding another icon library. Controls retain accessible labels. Filled collaboration status marks are deliberate exceptions to the outline family.

Motion communicates state through short transitions. Respect reduced-motion preferences and preserve static fallbacks for the orb, mascot, and rocket. Status meaning must remain understandable through text and shape as well as color.
