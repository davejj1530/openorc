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
  chrome: "44px"
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

OpenOrc is a compact desktop workspace for several projects at once. The sidebar, the conversation, the panel and the page toolbars share one near-white ground. Pieces sit on it in white with a thin ring and a faint shadow: the composer and cards in the transcript; Settings' tiles are white with no ring. A control inside a piece is a soft grey key, as a control on the ground is a soft grey fill, and the person's message is a grey bubble. Only what floats is raised: menus and popovers are white planes on a strong hairline and one soft shadow. Dark is the same sheet carved: a neutral #171717 ground with no blue, pieces cut to near black with no ring, keys 8.5% of white over them, menus near black on a strong hairline and one deep shadow. Each screen has one ink pill; everything else is quiet. The interface is set in Immaculate Gothic at one regular weight.

This record describes the built desktop interface. It preserves the workflows in [PRODUCT.md](../../PRODUCT.md), including drafts, task authorization, Orcling privacy, and project context. Original artwork and provider marks are documented in [artwork provenance](../../docs/artwork-provenance.md).

**Key Characteristics:**

- One near-white ground everywhere, white pieces on a thin ring, grey keys inside them, grey fills on the ground, white floating planes.
- Hierarchy from title ink, the softer reading ink, muted and faint text, and size, never from weight.
- Round controls: pills for buttons, chips, tracks, and send; 34px rows with r10 corners.
- Color only where it means something: diffs, results, attention dots, links, and selection.
- No keyboard shortcut hints and no capability advertising in the UI. The shortcuts themselves still work.

## Colors

The frontmatter records the OpenOrc palette in both modes; component entries show its light values. Components never use these literals. They read semantic roles from `app.css`, so every palette and saved custom color takes the same structure.

### Grounds and fills

`--bg` is the ground, one flat color in every palette, kept opaque because the native window background follows it. `--sidebar` is the sidebar's ground, `--bg` unless a palette tints it. `--well` is a piece on the ground (in light, the palette's plane, opaque in transparency mode; in dark, the ground carved toward black), `--well-ring` its edge (a thin ring and a faint shadow in light, none in dark), and `--key` a control inside a piece (the fill in light). `--surface` is the plane under code, diffs and what floats, and `--raised-shadow` lifts a floating plane (OpenOrc's strong hairline and one soft shadow; an empty shadow elsewhere). `--surface-2` is the fill: hover for bare rows, ghost buttons, and menu items, and the resting fill of chips, tracks, fields, and file heads. `--surface-3` is the strong fill, kept for press, hover on controls that already rest on a fill, switch-off tracks, empty rings, disabled send, and meter tracks. `--line` appears only between rows, at `--hairline` width (half a pixel on high-density screens). Sidebar rows hover on `--navigation-hover`.

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

Replies and prompts are 14/21; code is 12.5/20. Single-line rows use 16px leading. Long prose wraps; code and tables scroll in their own blocks. A table is no piece: it sits on the ground as hairlines under quiet heads, with no fill.

## Layout

The window has one navigation column, a conversation or destination, and an optional work panel. Toolbars are `max(44px, 32px / zoom)` and line up with the traffic lights at x16. The sidebar defaults to 247px, resizes from 224 to 380, and respects saved widths. The panel defaults to 640px within 340 to 900.

The conversation column is at most 800px with 32px reading gutters; the composer uses 24px. Both shrink to 12px at 520px and below and in narrow panes. Each column owns its scrolling. Split conversations keep their own header and panel ownership.

The sidebar is one column, 247px by default (224 to 380), on its `--sidebar` ground; a hairline in `--line` runs the window's full height at its right edge, through its header, and goes while the sidebar floats at 900px and narrower. Hidden, nothing of it stays, and the first header clears the traffic lights. Its 44px header has no line under it and clears the traffic lights where the OS draws them. The sidebar toggle leads the first header beside it, open or hidden. The signed-in space switcher shows OpenOrc in Personal and the organization's mark and name in an organization. Back and Forward sit at the end of the sidebar header when they fit beside the whole name. If they do not fit, they follow the sidebar toggle in the work column's header, as they do while the sidebar is hidden, and return when room allows. One measurement chooses their location, so exactly one pair is shown, dimmed when its history is empty. The name is never cut to make room for the arrows; a name too long for the row alone keeps whole-word clipping and its full-name tooltip. Signed out, the existing plain wordmark and header behavior remain. Under the header New thread leads, a pen in full ink, lit while its screen is open; then the app's screens as named rows, 34px apart, each glyph centred in an 18px lead slot 16px in, on the traffic lights' left edge, and the name at 42: Tasks, Pull requests, Schedules and Orclings. There is no Inbox: what waits on the person shows where it lives. A count sits at a row's end only where something waits: on Tasks, tasks whose run asks for an approval, tasks proposed and tasks in review, each once; on Orclings, Orcling chats with a question or a failure. Every count in the sidebar is amber, centred in a 16px slot on the line the row marks share, and counts nothing else; there are no grey totals. A thread waiting on an approval or a question carries its mark on its own row and counts on its project's label and on the folded Workspaces head, however old its work, since a thread that waits never goes to Resolved by age. Orclings is a toggle that swaps the threads for the Orclings list and back; while it does, its row carries New group chat and New Orcling at its end, and the list, with no head of its own, starts 18px under the screens. Memory is reached from the right panel and the palette. While Settings is open, its sections take the screens' and threads' place under Back to app. The 44px footer, under a hairline, holds the weekly usage, the update while one waits, and Settings at the row's end. Its start is the person's: a 36px row, signed in with a 26px face and two lines, the name at 14/16 and the plan at 12/14; signed out, Sign in, drawn as a screen row (a person glyph 16px in, the word in the third ink), which opens OpenOrc's sign-in page in the browser. While the page waits it reads "Signing in…" and its glyph turns, a cross under the pointer that calls the sign-in off; a sign-in that failed says why on a second line in the bad ink, cut to the width with the whole of it on hover. A build with no account server shows nothing there, and Settings has no Account section.

Scoped views keep project groups, counts, search and task lists within the selected space. An organization contains the local folders paired with its usable cloud projects and its readable cloud threads; Personal keeps unmatched folders and personal cloud work. A cloud project without a local folder uses the cloud mark and offers OpenOrc Cloud only. The organization filter adds Mine and Everyone's above the existing thread filters, without a heading. A window retains each space's tabs, split panes, destination and Back history independently. The account footer remains personal. Orclings and their group chats stay global, with their existing list and amber count in every space. Switching spaces from them, as from Settings, restores that space's last project-work destination. Tasks, Pull requests and Schedules follow the projects the current space lists, with amber counts using the same scope.

Create organization and Edit organization share a 420px dialog with the built Close control, an optional 48px raster logo, Name, Cancel and one primary action. Name refusals stay beside the input. A failed logo save after creation retains the created organization and offers Try again on its empty screen. The empty organization names itself above Add projects from GitHub and Invite people. The sidebar says “No projects yet.” for its admin, or “No projects available” for a member with none, including on People and Tasks. Add projects uses a 460px dialog: GitHub and Connect first, then a searchable repository list with individual results. With nothing selected its disabled key reads “Add projects”; after selection it reads “Add 1 project” or the plural count. Only the selected organization's installations and repositories appear; adding a cloud project never invents a local folder.

Settings > Account leads with the person's 44px face, name and address, with Edit and Sign out aligned to the account tile. Edit profile uses the same 420px identity form as an organization: a 48px face, Change picture, Remove, Name, Cancel and Save changes. An unchanged or empty name disables Save. Pictures are cropped locally to 128px and saved as normalized WebP; the shared face uses initials on a neutral fill when no picture is set. A successful save uses the stored identity in its reply, so later read failures never offer that write again. Other devices, People, teammate starters and invitation details update live. The Personal menu row keeps the OpenOrc mark, matching Personal at rest; invitation detail keeps the organization's mark with a small face beside the inviter's name.

People uses the shared list-page column with aligned Name, Plan and Role columns. Members see the same Pro facts as admins. The sole admin's own role is plain Admin; with another admin present, it becomes the normal role picker. A successful self-demotion immediately removes admin controls. More holds Edit organization, Leave organization and Delete organization with the appropriate permissions. Pending invitations are absent when there are none. Leaving or deleting restores Personal; removing someone keeps People open.

Invite people uses a person with a plus in the switcher and palette; Create organization keeps the plain plus. Invite people uses one 480px batch form, one role and a result for each address. Invalid addresses stay beside their errors; duplicates are sent once. Delivery failures keep a copyable link. A refusal keeps the form and the server’s words, with an enabled Try again that sends only refused addresses. Successful results stay visible and are never sent twice on retry. Editing the addresses begins a new send and restores Send invitations. Closing stops further addresses without undoing admitted invitations. The admin’s Invitations section follows People only when rows exist; Copy link uses the server’s URL, Resend counts down the server’s remaining delay with its reason on hover, and Revoke asks for confirmation. Logged mail says Not emailed. View invitations opens People at that section.

Received invitations appear only for their signed-in address and expire from the switcher at their deadline. Opening an invitation name shows its detail without joining; Join selects the organization and Decline leaves the current work alone. Web acceptance only updates the list and never moves another window.

If an organization write succeeds before its following read fails, say that the write worked and keep the read's own refusal. Retry reads only and must never repeat that completed write. Create and Join keep their detail with “You created [organization].” or “You joined [organization].” first, then the read error, and Open [organization]. Creation's name and logo become read-only; Join no longer offers Decline. A later good read completes the requested opening only while that detail remains open; Close cancels navigation, leaving the organization or membership intact and allowing the switcher to update quietly.

When the first spaces read fails without a cached index, the signed-in OpenOrc switcher remains. Its menu shows Personal checked, one quiet line with the read's own refusal and Try again beside it, then Create organization… disabled with that reason on demand. No failure dot or colour appears on the wordmark. The periodic reread can heal it; current work stays in place.

Project access opens from the project menu for organization admins. Its 520px dialog offers Everyone or Only people you choose; admins stay checked and cannot be unchecked. Chosen people remain remembered when Everyone is selected. A member with no projects sees the organization, “An admin needs to give you access to a project.” and People, with no Add project control.

When project access goes, its group and rows leave under the sidebar’s hold-still rule. An open cloud tab retains its title and position; the conversation and composer give way to the same quiet organization state, saying “You no longer have access to this project.” with People. Access returning restores the conversation in that tab. Project-scoped Tasks and Pull requests fall back to the space’s all-projects scope without a notice.

A change made elsewhere changes the project lists without moving an open local tab, its running turn or the person. This works in both directions: a folder returning to Personal after lost access, or leaving Personal after joining, a project addition or a grant. The open local conversation stays fully usable until close or space switch; New thread from that retained folder offers only this Mac's places until its listed space is selected.

Responsive rules:

- At 900px and narrower, the sidebar floats over the page on its opaque ground with `--shadow-overlay`. Opening a destination dismisses it; switching between Threads and Orclings keeps it open.
- At work-row widths of 788px or less, an open panel overlays the work area.
- New thread centers a 640px column; its composer bar wraps when the column narrows.

## Elevation & Depth

Depth is the fill step, lifted by `--raised-shadow` where the step alone is too faint. Persistent surfaces have no borders. Planes are one step from the ground, fills one step from theirs.

**The Floating Fill Rule.** Menus, popovers, tooltips, toasts, and dialogs have no border and wear `--raised-shadow`. They paint `--float-fill`: the plane when the layer lands on the tile or on a piece set into it (the composer, a card, a Settings tile), with a hairline ring in `--line-strong` over a piece; the tile when it lands on a plane, such as a sheet, a dialog, the panel or another menu (`use-anchor-ground` sets `data-ground` on the portal). Dialogs also dim their backdrop. A layer that lies across both, such as a composer picker over the conversation or an update toast over the transcript, has no fill step away from both, so a hairline ring in `--line-strong` draws its edge.

**The Opaque Work Plane Rule.** Keep reading, writing, and tool content opaque when Transparent surroundings is on. The setting paints the shell tint once through `--shell-opacity`, from 0% (solid tint) to 100% (native blur), defaulting to 35%. System Reduce Transparency wins.

## Shapes

Corner radius is set per component:

- 6: labels and diff runs.
- 10: rows and menu items.
- 12: tall rows, sheet fields, and diff file heads.
- 14: the browser viewport.
- 16: drop menus, command, schedule, and toast cards, code blocks.
- 18: popovers, prompt bubbles, permission, task, and MCP cards, settings cards.
- 20: the palette, sheets, dialogs, grown menus (model, branch, context, slash), steps and question cards, the conversation composer.
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

Menus are all one size: r16 with padding 6 and 34px r10 rows, 15px glyphs in the third ink, a hairline between kinds of action, and the destructive one last after a hairline. The palette is the one search, a floating plane 600 wide and r20 over a 30% scrim, its field 48px at lead size with "Search" as its placeholder; before a word is typed it lists recent threads, then actions; searching it lists threads, Orclings, tasks, messages and projects in 38px rows, each with its mark (a thread's state or the working cube, else its agent's), its place in faint ink and its age at the end. Grown menus (model, branch, mode) open out of their pill into an r20 layer. Tooltips are fill-step labels, opened once per group without a second delay. A plain line takes `data-tip` on its element, which the window's one tip layer opens (`TipLayer`); `Tooltip` wraps a control whose tip is more than a line. Nothing uses the browser's `title`, which waits longer and draws outside the app's look; a frame keeps `title` as its name. A tip that only repeats its element's words opens when those words are cut off, and a disabled control's tip says why.

### Sidebar

The wordmark is a 16px cube and "OpenOrc" in ink at 15px in Immaculate Gothic, whatever the interface font. It never truncates: short of room the name wraps onto a line the box clips, and the cube stays. The threads sit under a quiet "Workspaces" head, Search (which opens the palette, the app's one search, and also finds Orclings), Add project (a folder with a plus) and the filter at its end as 24px buttons, the last one centred on the line the counts and row marks share, 24px in from the sidebar's edge. Workspaces folds as a whole; its chevron shows on hover and while folded, and folded it keeps only its name and the amber count of what inside waits on the person, its tools back when it opens. The filter wears the funnel, or a pin for pinned threads, in the accent while either filters, and offers All threads, Pinned threads, a tick for each workspace in the list's order (unticked, a workspace leaves the list until it is ticked again, and ticking keeps the menu open) and importing terminal sessions; the cube belongs to the wordmark and agent presence only. Threads are grouped by project, in the order the day found them (a project added since leads), the most recently active first inside each, so a thread that gets activity rises in its project and no project moves for its work; Pinned leads in a group of its own that does not scroll with the rest, Snoozed follows the projects. Each group's label is a quiet 28px row in the titles' column like the old day headings, in the second ink, led by the project's mark at 14px in full in the 18px lead slot, so the name starts at 42 (its chosen or detected icon, else a folder; No project's globe, the group of the Workspace's threads, which belong to none), the rows flush with the slot's start, its chevron after the word on hover and while folded, an amber count at its end only when something in it waits on the person or failed (a question or a failure; an unread result is marked on its row and counted nowhere), and on hover or keyboard focus More and New thread for that project in the count's place. More, and a right click on the label, give New thread, New task, Choose icon, Project settings and Remove project; No project offers only New thread. A group shows its four most recently active threads and every other thread that is not quiet; "Show N more" adds ten at a time; folded it keeps only the open thread. While the pointer or the keyboard is in the list, rows that would arrive, leave or change place wait until the pointer has been off it a moment, and rows that land above the view leave what is on screen where it was. A question, a failure or an unread result that is not whole in view is named on a 28px line over the edge it is past: an amber chevron in the lead slot, its title and mark, or "N need you" for several; pressing the line scrolls the nearest one into view. Every project has a group, an empty one too; No project appears only while it holds threads. With no projects the list reads "No projects yet." The list reads further pages by itself until every group is whole. Resolved sits at the list's foot, with no rule: threads put there, and every thread quiet since before yesterday that no pin or snooze keeps out. Its heading is a 28px door, "Resolved" and a chevron after the word, with no count (it still holds the open thread when that one is resolved). Open, it rises over the list to its rows' height, at most 62% of the column, its rows arriving a stagger step apart, and folds with them; it pages on request. The list and Resolved each fade 16px at an edge with more scrolled past it. While a thread it would take is dragged, the heading grows to 44px and draws a dashed ring with a check in place of the chevron; held over it, the ring turns solid accent on the current-row fill. Dropping a resolved row on the list reopens it, the list ringed while it is held there. Resolve and Reopen are in the thread menu and on ⇧⌘A. A reopen counts as activity, so the thread comes back at the top, and a message to a resolved thread reopens it. Thread rows are one line: 32px high with 2px between rows, including children, on the named navigation rows' 34px pitch. They sit 8px from each sidebar edge with 8px horizontal padding, a 10px radius and a 14px regular title on an 18px line. Root titles start at x16; children step 24px to the existing depth cap. Quiet, working and background-command titles use `--ink-2`; waiting, failed and unread titles use `--ink`; hover uses `--ink`; an open pane uses `--navigation-ink` on `--current-row-fill`. Hover keeps `--navigation-hover`.

End marks keep the order teammate face, pull request, cloud and state, each 16px with 4px gaps and 8px before the strip. Only present marks take space, packed against the right edge. The last present mark is centred at x223 in a 247px sidebar and x200 at 224px, aligned with the navigation counts. Four present marks have centres 163/183/203/223 and 140/160/180/200 respectively. A lone PR occupies the last position; a plain row reserves no strip. The title uses all space up to the first present mark. Marks shift when other marks appear or disappear, without an added movement animation; the title start and row height stay fixed. The face is 14px with an initials fallback, PR and cloud glyphs are 14px, the working cube is 16px, question/failure/command marks are 14px and the unread dot is 7px. State precedence, the shared cube clock and its open-row ink stay unchanged. Teammate asks use the quiet question; the person's own asks use attention ink. Open PRs use the third ink, merged PRs `--ok`, closed PRs `--bad`, with their distinct glyphs. Every cloud thread has its cloud, including cloud-only projects, dimmed while its host is unreachable. Local checkouts and worktrees have no place mark. The title truncates first. Only at deep indents where even an ellipsis would not fit, remove outer columns in order: face, PR, cloud. State and disclosure remain. A parent's 24px disclosure stays last, with its present marks packed before it, ending 24px left of the usual line. Children keep their own state; the parent's aggregate still uses `threadTreeStatus`. Branch lines step 24px and stop 4px earlier to clear child titles.

Hover and keyboard focus show one metadata line, separated by `·`: latest activity age, project outside its project group, teammate's full name, place, branch or folder, PR number and state. Age uses the existing `now`, `3m`, `1h` vocabulary. Place is OpenOrc Cloud, Your own cloud, Worktree or This Mac. Include the actual branch, including main; without a branch, use the folder when available. Omit missing facts. Pinned, Snoozed and Resolved use the same row, with the project immediately after age in the tooltip. A clipped title appears complete above the facts; an uncut title is not repeated. Row facts use the existing 13/16 tooltip, 5px vertical and 9px horizontal padding, 10px radius, 6px offset and 800ms hover delay, widening to the viewport before wrapping. Descriptions include these facts and the teammate; status, cloud and PR keep descriptive accessible names. Subagents retain their completion/failure marks and spoken type, with the existing ticking elapsed time as a final `Running for …` fact only while running. Sorting, grouping, pagination, folding, split selection, drag and drop, keyboard movement, right-click menus and row destinations stay unchanged. There is no selected-row More control.

The usage button is the week's share left, filled on its disc and never an arc, then the number, and its gear's centre sits on the list's centre line. It reports on the open thread's account, or off a thread on the agent and account the new-thread composer has chosen, and opens a table of every account: the 5-hour and weekly share left with their resets, the thread's account first on the current-row fill, hairlines between the rest. Screens that follow a project title themselves with the app's scope, as in "studio / Tasks" or "All projects / Tasks"; the scope opens All projects, each project with its most pressing thread's mark, the chosen project's settings, New task and removal, and Add project.

### Conversation

The work column's header leads with its tabs, one for each open thread or new thread, in the order they were opened or dragged to; choosing one never moves it. A tab is its mark (the thread's state, its agent or its Orcling's face) and its name at 13px as plain words with no pill: the open one in full ink over a 2px line on the header's hairline, the others in the third ink and the second under the pointer. A tab takes its name's width up to 220px and gives way down to 136px, then the strip scrolls sideways, keeping the open tab in view. Its close shows on the open tab and on one under the pointer or holding focus, and a double-click on the open one renames it. The pen after the strip opens a new thread in a tab of its own. Every control that starts a thread wears the pen; a plus only adds one of the things beside it, and a folder with a plus adds a project. A split pane's header holds its title in a rename box. Then a faint run of facts (activity, pull request, snooze), Close pane, More, Tasks, and the panel toggle as round buttons. On every screen the work column's last header leads its round buttons with an Orcling's face alone: the one with the newest unread message, else the one last talked to, with the 7px unread dot while she has one. It opens a small chat with her under it, r20 and 380 wide, with her latest messages and a composer of attach and send; its corner opens her full chat.

User prompts are r18 plane bubbles, aligned right, capped at 88% of the column or 72ch, with no border. Replies are unboxed ink prose under a turn head (harness mark, agent, model, a status that swaps in place). Work collapses behind a receipt (thought time, steps, last check). The steps card is r20 with a 2px ink track when there is a plan; commands are r16 cards with their last output line. An approval or a question the agent waits on is not drawn in the thread: it docks on the composer (below). Once answered it is the thread's record of what was asked: a question an r20 card whose chosen options are keys with an ink edge and a check, the rest stepped back; a denied approval one quiet line; an allowed one its tool row. Changes close to one "Changed N files" line with a Review pill. Copy and Fork sit at the end of the turn, shown at rest only on the last visible one. A turn held only in the composer does not hide that row. The cube ends the thread: 24px, in ink and turning while the agent works, in the fourth ink and still at rest. Wherever an agent works (a row, a tab, the palette's thread rows, the project list, a task) the same cube turns at 16px in the third ink, in ink on the open row and the open tab. Its lit face steps top, right, left, each held 0.6s and crossed in 0.2s, and every cube in the window keeps one clock; reduced motion holds the top face lit. A command still running keeps its own mark, and steps and loads keep the ring.

An ask the agent waits on docks at the top of the composer's own piece, above a hairline, and the writing and the bar under it keep their shape. Its top line holds what it asks (the agent's mark for a question, the request's glyph for an approval), then how many more wait ("1 more waits"), and last its one quiet way out, Decline or Deny. A question's choices are keys the width of the piece: a single choice answers when pressed; several toggle, a picked one a key in the piece's fill with an ink edge and a check, and Answer joins the row. One ask of several questions shows one at a time under "1 of 3", each answer kept above as a line that reopens it, and the last Answer sends them all. A question whose agent takes words has its own line ("Something else", or "Your answer" with no choices), masked for a secret. An approval shows its request as summed up, the raw request on demand when it says more, a line "Say what to do instead", then Allow for this run (not for a request that can only be allowed once) and Allow once. The column keeps one ink: Allow once, or Answer once the answer is more than one press, or the line's own pill (Answer, Keep, Deny and send) while it holds words, and the field's own send when the field holds words; a single-choice question has none, and Stop stands aside as the white key. Words in the composer's field are always a message: with an ask waiting Enter queues them and Send now is dimmed with its reason. The keyboard enters an ask only at its question, by arrow up from an empty field or Shift and Tab, never at a choice, so a stray Enter answers nothing; arrows and Tab walk its controls, Escape or a letter goes back to the field, and an answer gives the keyboard back to the field. An ask that takes an answered one's place takes no press for 240ms. A long ask keeps to about half the window and scrolls under its top line. A thread out of reach, or a teammate's the person only reads, shows the ask with its answers dimmed and why on demand. The dock opens from nothing as its parts clear a blur and rise one after another, and leaves by blurring away, then folding; reduced motion shows and hides it at once. Each pane of a split view has its own. Where no composer takes an ask (a task's comment, a task's activity), the same parts sit in a card where it was asked.

### Composer

A live turn shows its head and timer as soon as it starts. An ask waiting in the composer does not count as turn content; once its turn rests, an ask alone leaves no head or empty space in the conversation. Prompts and answered records stay visible. Views without a dock keep asks in the conversation.

Threads on this Mac and on OpenOrc Cloud show the first nonblank line of the first message until the person or the small model names them. The first line is shortened to 72 characters after secrets are masked. After the first exchange, the sender’s app uses the conversation’s agent to propose a short name, only while the current name still matches that first line. A rename during generation wins, and another device cannot replace a name already saved. Teammates see the saved name live in the row and tab. An empty conversation reads “New thread”; a row or tab never has a blank name.

A teammate's thread that the person can only read keeps the field editable, with a quiet placeholder naming whose thread it is. One read-only rule disables Send, Queue, attach, the model and the mode, with the same reason on demand; Enter cannot send and Stop is absent. The pickers still show what the thread runs on. Its send cluster is always one bare disabled arrow, whether the thread works or rests and whether the draft is empty or has words. An owner's thread out of reach blocks sending but keeps its local choices. Drafts stay on this device. Neither state adds a card above the composer.

A teammate's thread waiting on an ask says who it waits on, using the starter's first name. Its question mark stays in quiet ink. It does not enter Needs you counts, parent counts or attention lines at the list's edge. The person's own asks keep their attention mark.

The conversation composer is one r20 surface on `--composer-input` with no inner well. One bar holds attach, the project or destination chip, model, and mode on the left, and activity, the context ring, and send on the right. It never wraps, scrolls or clips: short of room the chips give up words a step at a time, the model's effort, then the mode's and destination's names, then the model's name, keeping their marks. Send, Queue, and Stop are layers of one 32px ink pill. The mode pill grows a small menu of the levels the agent offers; it does not step. Clicking the context ring opens its details; only Compact compacts. When there are uncommitted changes, the Commit chip (Commit plus its +N −M totals) is first in the stack above the writing surface, aligned left. Queued messages, background work, cloud status, recovery, and all other notices follow the chip. Queued messages stack as a pile that fans out on click.

New thread keeps the tile ground. Its toolbar holds only the panel toggle, which shows and hides the panel; the 28/34 question is the page title; when the checkout has changes, the Commit chip sits right over the composer on its left edge; the r24 white composer has a 15/24 prompt and a 34px send. Nothing sits under it. Where the thread works is one icon in the composer's bar, after attach: the place's glyph, with one sentence on demand ("Works in the local checkout on main", "Works in a new worktree off main", "Works in your own cloud, on a new branch from main", "Works on OpenOrc Cloud, on a new branch from main"). It opens the place menu: Local checkout, Worktree, then a hairline and Your own cloud and OpenOrc Cloud, names alone, a pickable row ending in one quiet fact (the service, the hours left). With no project the icon is a folder and opens the folder chooser. No suggested prompts and no list of past threads or tasks. Along the bottom, aligned to the column, a year of the project's finished turns is one dot a day (a week to a column), growing from a 3px speck to 9px and from 10% to 54% ink with the day's rank among active days. The 12/16 line above it gives the turns and steps (tool calls, subagents' included) since the first active day, or "in the last year" once activity reaches the oldest week, and on hover the day, its turns, steps and threads, and each agent's share with its mark. The column's top takes back the activity's room, so the column centres exactly where it would without it; a pane under 600px leaves the activity out. New subthread shares the screen: the backdrop, the question naming the parent, and the project's activity.

### Work panel

The panel shares the conversation's ground from the window's top edge to its bottom, with no margin, card, or seam between its header and the open tab's page. The header shares the 44px chrome line. Tabs are 28px pills on the soft fill, the open one a raised white plane; a tab's close shows on the open one and under the pointer. The plus, expand, and hide are bare round buttons. Changes opens as the first tab. The panel's tabs and the work column's reorder by dragging: the held tab follows the pointer on an opaque fill, the tabs it passes step aside, and it glides into place on the drop; a strip that has outgrown its bar scrolls while a tab is held at either end. The round plus opens the New tab page with tool and recent page rows. Each tool page starts with a 48px bar (title, faint meta, actions); Commit is that page's ink pill and grows into the r22 commit sheet. Diffs fill the panel edge to edge with no inset, card, corners or gaps: 36px file heads on the ground with a hairline under them, each right under the row above it and its first line of code right under it; 20px rows of 12.5px mono on the plane, title-ink code on square `--ok-soft` and `--bad-soft` runs, `--line-number` numbers, full-width bars for unchanged runs, and no syntax colors. Web pages get a 44px bar with their own Back/Forward, an address pill, and an r14 inset viewport.

### Pages, tasks, and settings

Task details open on Overview. The tab track starts 24px below the top rail, aligned with the document's 800px column and 48px gutters (24px below 600px, 16px below 400px). Overview, Activity, Commits, and Memory share that column, with 32px between the track and body. Changes uses the workspace width. Tabs replace the page body; Memory shows task history without requiring an execution conversation. Keyboard navigation uses arrows, Home, and End, and leaving Overview waits for its edits to save.

Tasks, Pull requests and Schedules share one column, 1056 at most and centred, with no search of their own; the toolbar holds the page name, Tasks' filter menu, and the page's create pill. A row's lead (a glyph, a task's mark, a project's mark on a group label) sits in one 18px slot so words start in one column, and the last column of a row is its move. Lists group under quiet headings (13px name, chevron on hover) that count only what waits on the person, in amber. Task rows are 44px r12, bare, with a fill hover, title in ink (muted for backlog and proposed), then fixed columns: the first label as a dot and a word, the project with its mark, the age, and the move (Review on a task ready for review, the way to its thread before work starts). What waits leads: tasks whose run waits on an approval under Needs you, opening on their conversation, then Ready for review and Proposed, then the work in progress and the backlog. Schedules is 860 wide at the shared column's left edge, with no search: Active and Paused are its filter, and one tile set into the ground holds the rows, split by hairlines. A row is a round well for its glyph, the name over how often it runs, its model and its project, then fixed columns for the next run, the last run as a dot and a word, Open run when the last run failed in a thread, and the switch; a failed run that left no thread keeps its reason under the row. Run now, Open thread and Delete come on hover. Pull requests has no search: its well of four views is the filter, with an amber count on To review only. Each project's label counts in amber the rows whose next move is the person's, and those rows lead the group. A row is the glyph in its state's tone in the 18px lead slot, the title over its number, author and branches, then fixed columns: a dot and a word for its state (amber only when the move is the person's), the diff, the age, and last the move as a key: Review, with a second key naming the last model or Orcling reviewer that starts that review; Finish review for a draft waiting on this Mac; Open thread on the person's own pull request with changes requested, once the thread that opened it rests. A reviewer at work shows the cube and "is reviewing" with no move.

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
- Don't add borders to persistent surfaces, or any shadow but `--raised-shadow` on what floats, a piece's `--well-ring`, and the floating sidebar's overlay.
- Don't use bold, 11px text, or faint text on the strong fill.
- Don't show shortcut hints or advertise what a control can do; reasons belong on disabled controls, on demand.
- Don't ship a control that does nothing.

Source authority is `src/renderer/src/app.css`, `workspace-design.css`, `settings-design.css`, `styles/*.css`, the theme modules, and the production components. The direction contract is the first HTML comment in `src/renderer/index.html`.

For a safe visual preview, run `pnpm preview:design` from the repository root and open `http://127.0.0.1:5177/?view=workspace&theme=light`. `OPENORC_PREVIEW_PORT` changes the port. The preview renders production components with synthetic providers and session-only settings; it does not verify live provider actions or real Orcling services.
