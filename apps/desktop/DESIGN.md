---
name: OpenOrc desktop
description: A quiet multi-project workspace on a near-white ground, with soft grey fills, white planes lifted by a faint edge, and one ink action per screen.
colors:
  ground-light: "#fafafa"
  ground-dark: "#171717"
  sidebar-light: "#f9fbfd"
  sidebar-dark: "#141619"
  plane-light: "#ffffff"
  plane-dark: "#202020"
  fill-light: "#f0f0f0"
  fill-dark: "#262626"
  fill-strong-light: "#e8e8e8"
  fill-strong-dark: "#2e2e2e"
  selected-row-light: "#eef0f3"
  selected-row-dark: "#23262b"
  line-light: "#ebebeb"
  line-dark: "#2a2a2a"
  line-strong-light: "#dcdcdc"
  line-strong-dark: "#383838"
  ink-light: "#252525"
  ink-dark: "#ececec"
  reading-light: "#646464"
  reading-dark: "#a3a3a3"
  muted-light: "#636465"
  muted-dark: "#a4a5a7"
  faint-light: "#6d6d6e"
  faint-dark: "#8e8f91"
  line-number-light: "#8a8a8a"
  line-number-dark: "#6e6e6e"
  action-light: "#252525"
  action-dark: "#ececec"
  on-action-light: "#ffffff"
  on-action-dark: "#171717"
  ok-light: "#367b46"
  ok-dark: "#63c27a"
  ok-soft-light: "#e0fae3"
  ok-soft-dark: "#15291b"
  bad-light: "#c03737"
  bad-dark: "#f07878"
  bad-soft-light: "#fcecea"
  bad-soft-dark: "#301c1b"
  attention-light: "#b26a00"
  attention-dark: "#f0b35a"
typography:
  interface:
    fontFamily: '"Immaculate Gothic", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "14px"
    fontWeight: 400
    lineHeight: "20px"
    letterSpacing: "-0.005em"
  label:
    fontFamily: '"Immaculate Gothic", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "13px"
    fontWeight: 400
    lineHeight: "16px"
  body:
    fontFamily: '"Immaculate Gothic", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "14px"
    fontWeight: 400
    lineHeight: "21px"
    letterSpacing: "-0.005em"
  heading:
    fontFamily: '"Immaculate Gothic", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "16px"
    fontWeight: 400
    lineHeight: "22px"
    letterSpacing: "-0.01em"
  title-sm:
    fontFamily: '"Immaculate Gothic", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "22px"
    fontWeight: 400
    lineHeight: "28px"
    letterSpacing: "-0.015em"
  title:
    fontFamily: '"Immaculate Gothic", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "28px"
    fontWeight: 400
    lineHeight: "34px"
    letterSpacing: "-0.02em"
  stat:
    fontFamily: '"Immaculate Gothic", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "18px"
    fontWeight: 400
    lineHeight: "22px"
  code:
    fontFamily: '"JetBrains Mono Variable", "SF Mono", Menlo, Consolas, monospace'
rounded:
  sm: "6px"
  md: "10px"
  lg: "12px"
  viewport: "14px"
  xl: "16px"
  2xl: "18px"
  3xl: "20px"
  4xl: "22px"
  5xl: "24px"
  pill: "999px"
spacing:
  chrome: "52px"
  reading-gutter: "32px"
  composer-gutter: "24px"
  narrow-gutter: "12px"
  card-inset: "20px"
components:
  button-primary:
    backgroundColor: "{colors.action-light}"
    textColor: "{colors.on-action-light}"
    typography: "{typography.interface}"
    rounded: "{rounded.pill}"
    height: "30px"
  button-secondary:
    backgroundColor: "var(--control-fill)"
    textColor: "{colors.ink-light}"
    typography: "{typography.interface}"
    rounded: "{rounded.pill}"
    height: "30px"
  button-ghost:
    backgroundColor: "transparent"
    typography: "{typography.interface}"
    rounded: "{rounded.pill}"
    height: "30px"
  icon-button:
    backgroundColor: "transparent"
    rounded: "{rounded.pill}"
    size: "30px"
  row:
    backgroundColor: "transparent"
    typography: "{typography.interface}"
    rounded: "{rounded.md}"
    height: "34px"
  row-current:
    backgroundColor: "var(--current-row-fill)"
    textColor: "var(--navigation-ink)"
    rounded: "{rounded.md}"
    height: "34px"
  chip:
    backgroundColor: "{colors.fill-light}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    height: "22px"
  segmented-track:
    backgroundColor: "{colors.fill-light}"
    rounded: "{rounded.pill}"
    padding: "3px"
  menu:
    backgroundColor: "var(--float-fill)"
    rounded: "{rounded.xl}"
    padding: "6px"
  popover:
    backgroundColor: "var(--float-fill)"
    rounded: "{rounded.2xl}"
    padding: "6px"
  user-prompt:
    backgroundColor: "{colors.fill-light}"
    typography: "{typography.body}"
    rounded: "{rounded.2xl}"
    padding: "10px 14px"
  composer:
    backgroundColor: "var(--composer-input)"
    rounded: "{rounded.3xl}"
    padding: "14px 12px 12px 16px"
  composer-new-thread:
    backgroundColor: "var(--composer-input)"
    rounded: "{rounded.5xl}"
    padding: "18px 14px 14px 20px"
  send:
    backgroundColor: "{colors.action-light}"
    textColor: "{colors.on-action-light}"
    rounded: "{rounded.pill}"
    size: "32px"
  work-panel:
    backgroundColor: "{colors.plane-light}"
  settings-card:
    backgroundColor: "{colors.ground-light}"
    rounded: "{rounded.2xl}"
    padding: "20px"
---

# Design System: OpenOrc desktop

## Overview

First-run setup pairs a column of controls with a flat illustrated collage. Above 900px, the controls align with the window wordmark and the artwork sits toward the right edge, with a flexible gap between them. Navigation and the three-segment progress track stay in a fixed bottom bar. The illustration yields below 720px; setup content scrolls without moving the footer. Its original artwork has a fixed palette. Appearance starts with six palette choices and an expandable catalog; the selected palette stays visible when the catalog closes. An isolated renderer shows the actual app shell and New thread screen at desktop dimensions, then scales the entire view down. Example data and storage stay inside the preview; the selected palette, mode, and saved custom colors update it. Motion is a brief staggered entrance and a token-timed rearrangement between steps, with a settled reduced-motion state. Recovery remains a single-column screen. First-run agent choices form two columns directly on the page, with a logo, stacked name and status, and checkbox; the whole ready row toggles selection. At 400px and narrower, the choices use one column. The default-agent selector follows the choices, so selection precedes the default choice. Setup actions remain visible, while installation metadata stays in Connections. The content supports wheel, trackpad, and keyboard scrolling without a visible scrollbar.

**Creative North Star: "A calm place to think with coding agents"**

OpenOrc is a compact desktop workspace for several projects at once. The conversation, the panel and the page toolbars share one near-white ground, and the sidebar sits beside them on a faintly cool one. Soft grey fills sit on top: the person's message, idle pills, the composer's chips. Things that are raised (the composer, cards in the transcript, the open tab, New thread, menus) are white planes lifted by a faint edge and a 1px shadow; in dark mode the same planes step lighter than the ground. Each screen has one ink pill; everything else is quiet. The interface is set in Immaculate Gothic at one regular weight.

This record describes the built desktop interface. It preserves the workflows in [PRODUCT.md](../../PRODUCT.md), including drafts, task authorization, Orcling privacy, and project context. Original artwork and provider marks are documented in [artwork provenance](../../docs/artwork-provenance.md).

**Key Characteristics:**

- One near-white ground for the conversation and the panel, a cool sidebar, grey fills, raised white planes.
- Hierarchy from title ink, the softer reading ink, muted and faint text, and size, never from weight.
- Round controls: pills for buttons, chips, tracks, and send; 34px rows with r10 corners.
- Color only where it means something: diffs, results, attention dots, links, and selection.
- No keyboard shortcut hints and no capability advertising in the UI. The shortcuts themselves still work.

## Colors

The frontmatter records the OpenOrc palette in both modes; component entries show its light values. Components never use these literals. They read semantic roles from `app.css`, so every palette and saved custom color takes the same structure.

### Grounds and fills

`--bg` is the ground, one flat color in every palette, kept opaque because the native window background follows it. `--sidebar` is the sidebar's ground: `--bg` in every palette but OpenOrc's, whose sidebar is faintly cool. `--surface` is the plane, and `--raised-shadow` lifts it where the step from the ground is too faint to see (OpenOrc's faint edge and 1px shadow; an empty shadow elsewhere). `--surface-2` is the fill: hover for bare rows, ghost buttons, and menu items, and the resting fill of chips, tracks, fields, and file heads. `--surface-3` is the strong fill, kept for press, hover on controls that already rest on a fill, switch-off tracks, empty rings, disabled send, and meter tracks. `--line` appears only between rows, at `--hairline` width (half a pixel on high-density screens). Sidebar rows hover on `--navigation-hover`.

**The Contextual Fill Rule.** Selected rows paint `--current-row-fill` and secondary controls paint `--control-fill`. On the tile they are `--navigation-soft` and `--surface`. Every plane (`data-plane`, panel content, menus, dialogs, the composer) restates both as `--surface-2`, and a tile card inside a plane (settings cards, usage accounts, the memory control) restates them back to `--surface`. Mark new planes with `data-plane` instead of growing selector lists.

### Ink and accents

`--ink` is titles and primary text. `--prose-ink` is the agent's reading text, softer than titles in OpenOrc; headings and bold lead-ins stay in `--ink`. `--ink-2` and `--ink-3` are muted, the workhorse. `--ink-4` is faint, for meta, counts, and placeholders; it never sits on `--surface-3`. `--line-number` numbers a diff's lines. Every text role, `--ok` and `--bad` included, holds 4.5:1 on the ground, the sidebar, the plane, the fill and the selected and hovered rows; line numbers hold 3:1 on the ground, the plane and the diff's washes. `--accent` and `--accent-fg` make the one ink pill. Selected and open rows keep `--navigation-ink`, links and inline code use `--content-ink`, so palette accents survive. `--ok` and `--bad` (with soft companions) mark diffs and results, `--attention` colors dots only, and `--warn` is the readable warning text.

Appearance mode and palette selection stay independent. OpenOrc has the values above, Cursor keeps its own grays, and flat light palettes have a hand-tuned ground step so planes still separate. Accent choices and custom colors persist per palette and mode; fill and line roles accept `#rrggbbaa`. Original Kamakura, Cyberpunk, and Eliron themes keep their authored treatment. [Theme references](../../docs/theme-references.md) separate source values from adaptations.

## Typography

Immaculate Gothic sets the whole interface by default, in its Text 450 face. Settings > Appearance can switch to Inter, Geist, or the system font; `fonts.css` maps the choice. Code has its own picker: JetBrains Mono Variable by default, Geist Mono Variable, or the system monospace, applied through the runtime `--font-mono` token to code blocks, editors, diffs, and open terminals.

The interface uses one weight: `--font-weight-medium` and `--font-weight-semibold` are both 400. Bold survives only for author emphasis inside content (replies, task documents, comments). UI text is 12.5, 13, 14 or 15px; there is no 11px or 10px text. The scale, with its tracking, lives in `@theme static`:

- `xs` 12.5/16 for quiet lines (times, second lines, meta) and code, `sm` 13/16 for section labels, counts and small controls, `base` 14/20 for rows and labels, `md` 14/22 for writing, `header` 15/20 for a column's title in its header, `prose` 14/21 for reading, `lg` 16/22.
- `title-sm` 22/28 for document and page titles, `title` 28/34 for the New thread question and settings page titles.
- `stat` 18/22 and `stat-sm` 16/20 for numerals, always tabular.

Replies and prompts are 14/21; code is 12.5/20. Single-line rows use 16px leading. Long prose wraps; code and tables scroll in their own blocks.

## Layout

The window has one navigation column, a conversation or destination, and an optional work panel. Toolbars are `max(52px, 32px / zoom)` and line up with the traffic lights at x16. The sidebar defaults to 272px, resizes from 224 to 380, and respects saved widths. The panel defaults to 640px within 340 to 900.

The conversation column is at most 800px with 32px reading gutters; the composer uses 24px. Both shrink to 12px at 520px and below and in narrow panes. Each column owns its scrolling. Split conversations keep their own header and panel ownership.

The sidebar is one column, 247px by default (224 to 380), on its `--sidebar` ground; a hairline in `--line` runs the window's full height at its right edge, through its header, and goes while the sidebar floats at 900px and narrower. Hidden, nothing of it stays, and the first header clears the traffic lights. Its 52px header has no line under it: the traffic lights where the OS draws them, and the OpenOrc wordmark (where an organization's logo, name and switcher will go), and nothing else; the wordmark is not a button. The sidebar toggle and Back lead the first header beside it, open or hidden; Forward stays on ⌘]. Under the header New thread leads, a pen in full ink, lit while its screen is open; then the app's screens as named rows, 34px apart, each glyph centred in an 18px lead slot 20px in and the name at 46: Tasks, Pull requests, Schedules and Orclings. There is no Inbox: what waits on the person shows where it lives. A count sits at a row's end only where something waits: on Tasks, tasks whose run asks for an approval, tasks proposed and tasks in review, each once; on Orclings, Orcling chats with a question or a failure. Every count in the sidebar is amber, centred in a 16px slot on the line the row marks share, and counts nothing else; there are no grey totals. A thread waiting on an approval or a question carries its mark on its own row and counts on its project's label and on the folded Workspaces head, however old its work, since a thread that waits never goes to Resolved by age. Orclings is a toggle that swaps the threads for the Orclings list and back; while it does, its row carries New group chat and New Orcling at its end, and the list, with no head of its own, starts 18px under the screens. Memory is reached from the right panel and the palette. While Settings is open, its sections take the screens' and threads' place under Back to app. The footer, under a hairline, holds the weekly usage, the update while one waits, and Settings at the row's end, its start kept for the signed-in person.

Responsive rules:

- At 900px and narrower, the sidebar floats over the page on its opaque ground with `--shadow-overlay`. Opening a destination dismisses it; switching between Threads and Orclings keeps it open.
- At work-row widths of 788px or less, an open panel overlays the work area.
- New thread centers a 640px column; its composer bar wraps when the column narrows.

## Elevation & Depth

Depth is the fill step, lifted by `--raised-shadow` where the step alone is too faint. Persistent surfaces have no borders. Planes are one step from the ground, fills one step from theirs.

**The Floating Fill Rule.** Menus, popovers, tooltips, toasts, and dialogs have no border and wear `--raised-shadow`. They paint `--float-fill`: the plane when the layer lands on the tile, the tile when it lands on a plane (`use-anchor-ground` sets `data-ground` on the portal). Dialogs also dim their backdrop. A layer that lies across both, such as a composer picker over the conversation or an update toast over the transcript, has no fill step away from both, so a hairline ring in `--line-strong` draws its edge.

**The Opaque Work Plane Rule.** Keep reading, writing, and tool content opaque when Transparent surroundings is on. The setting paints the shell tint once through `--shell-opacity`, from 0% (solid tint) to 100% (native blur), defaulting to 35%. System Reduce Transparency wins.

## Shapes

Corner radius is set per component:

- 6: labels and diff runs.
- 10: rows and menu items.
- 12: tall rows, sheet fields, and diff file heads.
- 14: the browser viewport.
- 16: drop menus, command, schedule, and toast cards, code blocks.
- 18: popovers, the palette, prompt bubbles, permission, task, and MCP cards, settings cards.
- 20: sheets, dialogs, grown menus (model, branch, context, slash), steps and question cards, the conversation composer.
- 22: the commit sheet and usage account cards.
- 24: the New thread composer.
- Full: buttons, chips, tracks, and send.

Control sizes: Button sm 28, md 30, lg 32, xl 36, hero 40. IconButton 24, 28, 30, or 32, always round. Chips and badges 22, rows 34, send 32 (34 on New thread).

Icons are [Precision Outline](../../docs/precision-outline-icons.md): a 24-unit grid, 1.75 strokes, rounded joins and caps, `currentColor`, from `components/icons.tsx`. Filled collaboration marks, the Hollow conversation indicator, and upstream framework logos remain deliberate exceptions. Orclings keep their own shapes and colors.

## Motion

Motion uses tokens only: leaving 160ms; arriving 220ms with opacity, a 4px blur, and a 4px rise; a 40ms stagger capped near eight rows; confirmations with one overshoot over 260 to 360ms; shape resizes over 420ms. Menus open out of the control that was touched, and states swap in place. History loads and remounts never animate. Under reduced motion, every duration and delay is zero and every keyframe ends visible.

## Components

### Controls

Use the shared primitives in `components/ui.tsx`, `Segmented.tsx`, and `menu.ts`. Primary is the ink pill, secondary and danger rest on `--control-fill` (danger with a `--bad` label), ghost is bare with a fill hover. `hover-step` layers the fill step over a control's own fill so hover reads on tile and plane. Segmented controls are a fill track at natural width with a surface knob that slides over 320ms. Switches are an ink track when on and `--surface-3` when off. Fields are fills with no border; focus deepens the fill instead of drawing a ring, while buttons, chips, and segmented choices draw a 2px `--ring` outline on keyboard focus. Badges are neutral fill pills; status reads as a 7px `StatusDot` and a word.

Menus are r16 with 36px r10 rows, muted glyphs, and hairline separators. Grown menus (model, branch, mode) open out of their pill into an r20 layer. Tooltips are fill-step labels, opened once per group without a second delay. A plain line takes `data-tip` on its element, which the window's one tip layer opens (`TipLayer`); `Tooltip` wraps a control whose tip is more than a line. Nothing uses the browser's `title`, which waits longer and draws outside the app's look; a frame keeps `title` as its name. A tip that only repeats its element's words opens when those words are cut off, and a disabled control's tip says why.

### Sidebar

The wordmark is a 16px cube and "OpenOrc" in ink at 15px in Immaculate Gothic, whatever the interface font. It never truncates: short of room the name wraps onto a line the box clips, and the cube stays. The threads sit under a quiet "Workspaces" head, Search (which opens the palette, the app's one search, and also finds Orclings), Add project (a folder with a plus) and the filter at its end as 24px buttons, the last one centred on the line the counts and row marks share, 28px in from the sidebar's edge. Workspaces folds as a whole; its chevron shows on hover and while folded, and folded it keeps only its name and the amber count of what inside waits on the person, its tools back when it opens. The filter wears the funnel, or a pin for pinned threads, and offers All threads, Pinned threads and importing terminal sessions; the cube belongs to the wordmark and agent presence only. Threads are grouped by project, in the order projects come (latest activity first), newest work first inside each; Pinned leads in a group of its own, Snoozed follows the projects. Each group's label is a quiet 28px row in the titles' column like the old day headings, in the second ink, led by the project's mark at 14px in full in the 18px lead slot, so the name starts at 46 (its chosen or detected icon, else a folder; No project's globe, the group of the Workspace's threads, which belong to none), the rows flush with the slot's start, its chevron after the word on hover and while folded, an amber count at its end only when something in it waits on the person or failed (a question or a failure; an unread result is marked on its row and counted nowhere), and on hover or keyboard focus More and New thread for that project in the count's place. More, and a right click on the label, give New thread, New task, Choose icon, Project settings and Remove project; No project offers only New thread. A group lists four threads, then "Show N more" adds ten at a time; folded it keeps only the open thread. Every project has a group, an empty one too; No project appears only while it holds threads. With no projects the list reads "No projects yet." The list reads further pages by itself until every group is whole. Resolved sits at the list's foot, with no rule: threads put there, and every thread quiet since before yesterday that no pin or snooze keeps out. Its heading is a 28px door, "Resolved" and a chevron after the word, with no count (it still holds the open thread when that one is resolved). Open, it rises over the list to its rows' height, at most 62% of the column, its rows arriving a stagger step apart, and folds with them; it pages on request. The list and Resolved each fade 16px at an edge with more scrolled past it. While a thread it would take is dragged, the heading grows to 44px and draws a dashed ring with a check in place of the chevron; held over it, the ring turns solid accent on the current-row fill. Dropping a resolved row on the list reopens it, the list ringed while it is held there. Resolve and Reopen are in the thread menu and on ⇧⌘A. A reopen counts as activity, so the thread comes back at the top, and a message to a resolved thread reopens it. A thread row is two lines, 46px apart and flush with its label: the muted title with its mark at the end (a spinner while an agent works; otherwise a solid shape with one cut, so no state is told by colour alone: an amber disc with a question when it needs you, a red triangle when it failed, a rounded square with a prompt in the third ink while a command it left goes on, a 7px ink dot for an unread result; a task ready for review wears the amber disc with no cut), then one quiet line of where it works (cloud, worktree, the branch, or checkout when the checkout is on none; a thread in no project names its folder) and its pull request at the end, its own icon for open, merged and closed, faint, green or red, then the number. In Pinned, Snoozed and Resolved the line starts with the project's name. While an agent works the title lights up left to right; what the agent is doing stays off the row. The open row takes `--current-row-fill` and `--navigation-ink`. A parent's chevron sits at the end of its title line, pointing down while its sub threads are folded and up while they show; its hairline branch leaves from under its title's start, and sub threads step in 24px with their marks ahead of their titles. The usage button reports on the open thread's account, or off a thread on the agent and account the new-thread composer has chosen, and opens a table of every account: the 5-hour and weekly share left with their resets, the thread's account first on the current-row fill, hairlines between the rest. Screens that follow a project title themselves with the app's scope, as in "studio / Tasks" or "All projects / Tasks"; the scope opens All projects, each project with its most pressing thread's mark, the chosen project's settings, New task and removal, and Add project.

### Conversation

The work column's header leads with the open thread's name as the column's heading: its agent's mark, then the title at 15/20 in title ink with no pill, taking the room it needs up to 420px, its close on hover and a double-click to rename. The other open threads follow it as 28px tabs on the soft fill, in the order they were opened or dragged to. Short of room they shrink to 120px, then the last of them move into an "N more" menu after the strip; the heading gives up room only once every other thread is in the menu. Choosing one makes it the heading and puts the one it replaces back among them. The pen after the strip opens a new thread in a tab of its own. Every control that starts a thread wears the pen; a plus only adds one of the things beside it, and a folder with a plus adds a project. A split pane's header holds its title in a rename box. Then a faint run of facts (activity, pull request, snooze), Close pane, More, Tasks, and the panel toggle as round buttons.

User prompts are r18 plane bubbles, aligned right, capped at 88% of the column or 72ch, with no border. Replies are unboxed ink prose under a turn head (harness mark, agent, model, a status that swaps in place). Work collapses behind a receipt (thought time, steps, last check). The steps card is r20 with a 2px ink track when there is a plan; commands are r16 cards with their last output line; approvals are r18 cards, questions r20 with fill options. Changes close to one "Changed N files" line with a Review pill. Copy and Fork sit at the end of the turn, shown at rest only on the latest one. The cube still follows a finished reply.

### Composer

The conversation composer is one r20 surface on `--composer-input` with no inner well. One bar holds attach, the project or destination chip, model, and mode on the left, and activity, the context ring, and send on the right. It never wraps, scrolls or clips: short of room the chips give up words a step at a time, the model's effort, then the mode's and destination's names, then the model's name, keeping their marks. Send, Queue, and Stop are layers of one 32px ink pill. The mode pill grows a small menu of the levels the agent offers; it does not step. Clicking the context ring opens its details; only Compact compacts. When there are uncommitted changes, the Commit chip (Commit plus its +N −M totals) is first in the stack above the writing surface, aligned left. Queued messages, background work, cloud status, recovery, and all other notices follow the chip. Queued messages stack as a pile that fans out on click.

New thread keeps the tile ground. Its toolbar holds only the panel toggle, which shows and hides the panel; the 28/34 question is the page title; when the checkout has changes, the Commit chip sits right over the composer on its left edge; the r24 white composer has a 15/24 prompt and a 34px send. Under it one sentence with one verb says where the thread works ("Works in the local checkout on main", "Works in a new worktree off main", "Works in your own cloud, on a new branch from main", "Works on OpenOrc Cloud, on a new branch from main"), led by its place's glyph, and opens the place menu: Local checkout, Worktree, then a hairline and Your own cloud and OpenOrc Cloud, names alone, a pickable row ending in one quiet fact (the service, the hours left). No suggested prompts and no list of past threads or tasks. Along the bottom, aligned to the column, a year of the project's finished turns is one dot a day (a week to a column), growing from a 3px speck to 9px and from 10% to 54% ink with the day's rank among active days. The 12/16 line above it gives the turns and steps (tool calls, subagents' included) since the first active day, or "in the last year" once activity reaches the oldest week, and on hover the day, its turns, steps and threads, and each agent's share with its mark. The column's top takes back the activity's room, so the column centres exactly where it would without it; a pane under 600px leaves the activity out. New subthread shares the screen: the backdrop, the question naming the parent, and the project's activity.

### Work panel

The panel shares the conversation's ground from the window's top edge to its bottom, with no margin, card, or seam between its header and the open tab's page. The header shares the 52px chrome line. Tabs are 28px pills on the soft fill, the open one a raised white plane; a tab's close shows on the open one and under the pointer. The plus, expand, and hide are bare round buttons. Changes opens as the first tab. The panel's tabs and the work column's reorder by dragging: the held tab follows the pointer on an opaque fill, the tabs it passes step aside, and it glides into place on the drop; a strip that has outgrown its bar scrolls while a tab is held at either end. The round plus opens the New tab page with tool and recent page rows. Each tool page starts with a 48px bar (title, faint meta, actions); Commit is that page's ink pill and grows into the r22 commit sheet. Diffs fill the panel edge to edge with no inset, card, corners or gaps: 36px file heads on the ground with a hairline under them, each right under the row above it and its first line of code right under it; 20px rows of 12.5px mono on the plane, title-ink code on square `--ok-soft` and `--bad-soft` runs, `--line-number` numbers, full-width bars for unchanged runs, and no syntax colors. Web pages get a 44px bar with their own Back/Forward, an address pill, and an r14 inset viewport.

### Pages, tasks, and settings

Task details open on Overview. The tab track starts 24px below the top rail, aligned with the document's 800px column and 48px gutters (24px below 600px, 16px below 400px). Overview, Activity, Commits, and Memory share that column, with 32px between the track and body. Changes uses the workspace width. Tabs replace the page body; Memory shows task history without requiring an execution conversation. Keyboard navigation uses arrows, Home, and End, and leaving Overview waits for its edits to save.

Tasks, Pull requests, Schedules, and Memory share one header: the toolbar holds the page name, a round search that grows into a field, a filter menu, and the page's lg secondary create pill. Lists group under quiet headings (13px name, faint count, chevron on hover) in a 1120px column. Task rows are 44px r12, bare, with a fill hover, title in ink (muted for backlog and proposed), and a priority glyph in a fixed trailing slot. Tasks whose run waits on an approval lead the list under Needs you and open on their conversation, where the approval waits; Ready for review and Proposed follow the work in progress. Schedules are r16 plane cards with a switch for Pause/Resume.

Settings is a plane sheet beside the sidebar, which lists its sections. Like the work panel, it runs flush to the window edges with its toolbar inside it. Each page has a 28/34 title and one faint line of context in a left-aligned 860px column. Groups and cards are tile cards on the sheet (r18, 20px inset), with hairlines between rows. Appearance tiles are fill-only with a navigation ring on the current choice.

Usage uses a wider 1120px column with Cost, Tokens, and Limits views. Its agent filter and date range sit above a total and agent list beside the trend chart; below are token totals, their composition, and a model or day breakdown. Below 760px of content width the summary and chart stack. Cost is labeled API estimate: Codex uses recorded tokens and published model prices, while other agents supply estimates. Unavailable prices and tokens are named explicitly. Limits retains the r22 account cards and 48px rings for the allowance remaining, with reset controls and recovery links intact.

Connections lists enabled agents in one group with hairlines between rows. Each row keeps its mark, name, connection status, version, and enable switch visible; expanding the name reveals installation details. Update actions and errors remain visible. Add agents is a compact disclosure at the bottom of the same group, and update preferences sit in a separate group below.

Settings actions live with their content: Refresh connections beside Coding agents, Pair a phone beside Paired phones, and connector actions beside the page description above their list. The 520px connector dialog uses 40px sheet fields and a two-column agent list that becomes one column in narrow windows. Optional headers or environment variables sit behind a disclosure. The title and action footer stay in place while the fields scroll; validation appears above the footer buttons.

Claude accounts use the same grouped rows: account name and identity on the left, connection status and an overflow menu on the right, and a quiet Default label beside the chosen name. Sign in and Cancel sign-in remain visible when needed; Rename, Make default, Sign in again, and Enable or Disable live in the menu. Rename opens an inline form. Add account opens a form in the group's last row, with account-switching preferences in a separate group below.

**The Save Feedback Rule.** Announce actual saves and errors in place (Save becomes Saved with a check); leave the idle state empty.

**The Recovery Visibility Rule.** Keep actionable resets and unresolved attempts visible on the front of a usage card.

Agent and app update notices are r16 toasts in the upper-right stack with sm pills, a 3px progress track, and per-version Later. They cover the native Preview while visible. Details stay in [Interface conventions](../../docs/design-system.md).

## Do's and Don'ts

- Do read semantic roles and the contextual fills; never paste OpenOrc literals into components.
- Do keep one ink pill per screen and let everything else rest on fills.
- Do keep every existing control and saved state; restyle, don't remove.
- Do preserve saved widths, palettes, custom colors, keyboard access, native window clearance, drafts, and Orcling privacy.
- Don't add borders to persistent surfaces, or any shadow but `--raised-shadow` and the floating sidebar's overlay.
- Don't use bold, 11px text, or faint text on the strong fill.
- Don't show shortcut hints or advertise what a control can do; reasons belong on disabled controls, on demand.
- Don't ship a control that does nothing.

Source authority is `src/renderer/src/app.css`, `workspace-design.css`, `settings-design.css`, `styles/*.css`, the theme modules, and the production components. The direction contract is the first HTML comment in `src/renderer/index.html`.

For a safe visual preview, run `pnpm preview:design` from the repository root and open `http://127.0.0.1:5177/?view=workspace&theme=light`. `OPENORC_PREVIEW_PORT` changes the port. The preview renders production components with synthetic providers and session-only settings; it does not verify live provider actions or real Orcling services.
