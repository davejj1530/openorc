# OpenOrc: rail and document study

## Overview

**Creative North Star: "A calm place to think with coding agents"**

This study explores a structural redesign inspired by Bear, Craft, and Apple's desktop conventions. It covers the desktop interface; packaged application artwork remains unchanged.

The shell has one resizable thread sidebar beside a compact rail of app destinations. A project picker at the top of the thread list replaces the separate project library. Its popover retains project import, icon customization, and removal. The thread list keeps its title filter, pinned and archived views, dates, status, and provider identity. The workspace is a reading and writing document. Its editable thread title, Tasks, Changes, and team controls live in one top toolbar. Agent and project identity stay with the composer; the conversation header does not repeat Thread/Codex or Conversation/project labels. Other destinations reclaim the thread browser's space.

**Key Characteristics:**

- One thread sidebar with a compact app rail.
- Compact thread titles in the toolbar and one author line per conversation turn.
- Flat preference groups and an account usage ledger.

## Colors

The OpenOrc preset pairs pearl reading surfaces and cool gray navigation with a blue accent. Dark mode uses flat cool charcoal and periwinkle accents. These are OpenOrc adaptations, not sampled Craft tokens. Craft’s September 2026 [color update](https://www.craft.do/blog/craft-update-3-6-0) informs the flexible accents and contrast-aware color approach. Components consume semantic variables, so saved palettes and custom colors still apply. Thread selection uses a navigation-accent tint without a border, leading edge, or shadow. Main work planes stay opaque; the native transparency preference continues to affect surrounding navigation. Existing icons, status colors, and artwork retain their meanings.

Settings → Appearance separates Actions, Navigation, and Content accents. Four coordinated combinations and individual color/hex controls derive readable text and tints. Choices persist per palette and appearance mode; roles without an override follow the action accent. Palette default resets the accents while retaining surface and text edits. Existing fine-grained color overrides remain available under Fine-tune individual colors.

**The Semantic Color Rule.** Read live palette roles instead of hardcoding study colors into components.

## Typography

Thread titles use compact 13px semibold system type in the top toolbar. Charter (with platform serif fallbacks) remains for task and welcome-page headings. Native sans-serif stays in controls and 15px conversation prose at 1.65 line height; code keeps JetBrains Mono. Settings uses compact section headings and supporting descriptions. Usage percentages and time labels use aligned numerals.

## Layout

Thread rows use 13px titles with dates, branch, and provider on one metadata line, typically 62px tall. Conversations start directly beneath the toolbar, without a second title or metadata header. Message spacing follows a tighter working rhythm. The thread browser retains the persisted sidebar width (default 288px), without a left divider. The rail is 56px wide with 40px navigation buttons. Native window-control clearance is reserved independently in the thread browser and main toolbars, including rail-only views, compact overlays, fullscreen, and zoom. Window navigation lives in the main toolbar. The reading measure is up to 860px with 48px gutters, reduced in narrower columns. Below 900px, navigation overlays the workspace. Opening a thread or an app destination dismisses it. The independent tools panel retains its existing resize, overlay, and expansion behavior.

Project selection scopes the current view. In a conversation it changes the thread list; in Tasks it filters tasks without navigating away. Global All threads retains all projects when opening a thread. The local filter searches loaded titles; Load more remains available. Command-click or Control-click opens a split pane. Context menus retain pinning, archiving, snoozing, and other thread actions. Native window controls, history, keyboard shortcuts, and resize handles remain supported.

Settings uses a horizontal icon-and-label category toolbar, with a content width up to 960px. Flat preference groups align their introductions beside the controls and stack below an 800px container width. On narrow screens the category toolbar scrolls horizontally and keeps the selected tab visible; usage rows reflow below 540px. Settings does not add a nested sidebar.

## Elevation & Depth

Working documents, selection rows, composers, settings groups, and persistent controls stay flat, separated by spacing, type, tonal fills, and quiet rules. App-scoped material tokens remove cast and inset shadows from these surfaces. Popovers and temporary overlays keep their floating material.

The top and left rails share the sidebar color without header dividers, forming one continuous frame. The thread-browser seam starts below the toolbar. Transparent surroundings paints the frame once, with the reading plane and thread browser's separate tint beginning below their headers.

The sidebar resize grip sits directly on the seam between navigation and the workspace. Its hit area extends into the workspace without covering the sidebar scrollbar. The existing drag, keyboard resize, and reset behavior remains intact.

## Components

### Conversation and tasks

User and assistant messages are labeled sections. User messages have a quiet rule instead of a chat bubble. The thread title is editable in the top toolbar, without a Thread/Codex eyebrow or repeated Conversation/project labels. Team status opens a menu for revision details, activity visibility, and lead-context compaction; pending compact requests remain identifiable on the trigger. Saved-task activity keeps a small inline fallback when no thread toolbar is present. Named team replies use one compact avatar/name/model/time line instead of repeating Assistant beneath it. Model and project context remain in the composer, which separates its writing surface, settings toolbar, and Git summary below.

The new-thread page puts an introduction and editable starter prompts immediately before the composer. Selecting a starter prepares a plan; it never sends. Existing activity follows the composer. Tasks have a document heading, functional status filters, and 46px grouped rows; keyboard navigation and status menus remain available.

### Preferences and focus

Text-entry focus changes the surface and caret without a ring or shadow. Buttons, tabs, swatches, and disclosure controls retain visible keyboard focus. Category tabs support arrow-key navigation. Palette choices use compact swatch strips and update the app live. Existing settings controls and persistence remain intact.

**The Save Feedback Rule.** Announce actual saves and errors in normal document flow; leave the idle state empty.

### Identity and Orclings

The rail and generic agent presence use a single-color face with transparent eyes. Its silhouette belongs to the Orcling family, and its color follows the active palette. Thinking uses a restrained opacity pulse; reduced motion disables it. The packaged application icon is unchanged.

The Orcling study has its own face icon in the app rail, beside Threads. Threads shows project conversations; Orclings shows companions. Both reuse the same sidebar space and restore their last selected conversation when switching destinations. Project links stay out of the companion list. On narrow windows, switching between these two destinations keeps the list open; selecting a conversation dismisses it. Individual shapes and colors carry identity. Conversations use the same flat document and composer. Profile replaces the conversation in the main pane, with horizontal Appearance, Instructions, and Memory tabs. Shape and color choices update the avatar everywhere; text edits and sample messages remain local to the preview.

After merging `main` at `5defebb`, the production sidebar connects the dedicated Orclings destination to real companions, private chats, and the existing profile and designer. Companion chats are excluded from project thread lists. The standalone preview keeps sample identities and session-only edits, now sharing the production artwork. Its expanded profile layout remains a design study; preview actions do not call Orcling services.

The merge also preserves configurable navigation through More → Edit sidebar and the header Inbox. Search stays in the rail when navigation is open and moves into the toolbar when it is closed. The additional Eliron palette and status-color reset behavior remain available alongside the new OpenOrc preset.

### Account usage

Usage is an account ledger. Each allowance shows one primary reported remaining or used percentage, a thin meter, and relative reset time. Missing values, stale reports, errors, and unavailable reset times stay explicit. Report details disclose source, timestamps, and local activity separately from provider allowances.

**The Recovery Visibility Rule.** Keep actionable resets and unresolved attempts visible. Preserve the reset attempt's state when the provider inventory changes.

## Do's and Don'ts

- Do preserve saved palettes, independent accent roles, and custom colors.
- Do keep native window-control clearance, keyboard access, and existing product workflows.
- Do keep save feedback and provider recovery state close to their controls.
- Don't add a nested settings sidebar or repeat context already present in the composer.
- Don't treat this study as global product identity approval or synthetic preview content as product facts.

## Preview and verification

Run `pnpm preview:design`, then open `http://127.0.0.1:5177/?design=1&view=teams&theme=light&accent=default`. The preview uses production components, synthetic providers, and session-only settings mocks; no real account operations occur. Its view selector covers the workspace and settings categories in light and dark appearance.

The implementation lives in the rail, project picker, sidebar, thread title and tools, welcome, conversation, composer, task, and settings components, with `workspace-design.css` and `settings-design.css`. Captures in the ignored `output/design-review/` directory cover every settings category, light/dark Appearance and Usage, narrow settings layouts, and `clean-conversation.png`.

The settings pass was reviewed with a SHIP disposition and verified across all eight categories. The title, palette, and team-toolbar refinement passed 36 relevant renderer tests, typecheck, lint, build, and size checks. Captures cover light/dark conversations, team menus, split panes with long titles, and 390px/549px windows with no header overlap or console errors. Interaction checks cover rename commit/cancel, panel ownership, team activity controls, and independent accent persistence. Synthetic previews do not exercise live provider actions.

The flat-surface and Orcling pass passed 33 relevant renderer tests, application and fixture typechecks, lint, build, and size checks. Captures cover light/dark conversations and Orcling profiles at desktop, 549px, and 390px widths with no horizontal overflow or console errors. Computed selected-row and composer shadows are `none`; the sidebar seam and resize handle share an exact coordinate before and after pointer and keyboard resizing. Orcling checks cover contact search and navigation, local creation, shape/color updates, keyboard choices, instruction saves, sample messages, and navigation dismissal on narrow windows. These interactions use fixture data only.

The dedicated Orclings navigation and main integration pass passed all 952 desktop tests across 177 files, desktop typecheck, repository lint, build, and size checks. The navigation checks cover separate active destinations, one shared sidebar, remembering the selected companion and project thread, entry from Settings, compact navigation dismissal, and a working sidebar close control. Desktop, 819px, and 390px captures show no horizontal overflow or runtime console errors. The integration includes main through `5defebb`.
