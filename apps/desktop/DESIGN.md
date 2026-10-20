---
name: OpenOrc desktop
description: A quiet multi-project workspace on one tile ground, with white planes, fill steps for depth, and one ink action per screen.
colors:
  tile-light: "#f4f4f4"
  tile-dark: "#171717"
  plane-light: "#ffffff"
  plane-dark: "#0a0a0a"
  fill-light: "#1717170d"
  fill-dark: "#ffffff12"
  fill-strong-light: "#17171717"
  fill-strong-dark: "#ffffff1f"
  line-light: "#17171717"
  line-dark: "#ffffff1c"
  line-strong-light: "#1717172e"
  line-strong-dark: "#ffffff2e"
  ink-light: "#171717"
  ink-dark: "#ffffff"
  muted-light: "#555555"
  muted-dark: "#b8b8b8"
  faint-light: "#666666"
  faint-dark: "#8e8e8e"
  action-light: "#171717"
  action-dark: "#ffffff"
  on-action-light: "#ffffff"
  on-action-dark: "#000000"
  ok-light: "#1e7359"
  ok-dark: "#7cc4a2"
  bad-light: "#9b5050"
  bad-dark: "#e2a3a3"
  attention-light: "#b26a00"
  attention-dark: "#f0b35a"
typography:
  interface:
    fontFamily: '"Immaculate Gothic", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "13px"
    fontWeight: 400
    lineHeight: "20px"
    letterSpacing: "-0.005em"
  label:
    fontFamily: '"Immaculate Gothic", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "12px"
    fontWeight: 400
    lineHeight: "16px"
  body:
    fontFamily: '"Immaculate Gothic", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "14px"
    fontWeight: 400
    lineHeight: "22px"
    letterSpacing: "-0.01em"
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
  panel-margin: "8px"
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
    backgroundColor: "{colors.plane-light}"
    typography: "{typography.body}"
    rounded: "{rounded.2xl}"
    padding: "12px 16px"
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
    rounded: "{rounded.3xl}"
  settings-card:
    backgroundColor: "{colors.tile-light}"
    rounded: "{rounded.2xl}"
    padding: "20px"
---

# Design System: OpenOrc desktop

## Overview

**Creative North Star: "A calm place to think with coding agents"**

OpenOrc is a compact desktop workspace for several projects at once. The sidebar, the conversation, and the page toolbars share one tile ground. Work that needs its own room (the work panel, the settings sheet, cards in the transcript, the composer) sits on white planes, carved darker than the tile in dark mode. Depth comes from fill steps alone: no borders on persistent surfaces and no shadows on floating ones. Each screen has one ink pill; everything else is quiet. The interface is set in Immaculate Gothic at one regular weight.

This record describes the built desktop interface. It preserves the workflows in [PRODUCT.md](../../PRODUCT.md), including drafts, task authorization, Orcling privacy, and project context. Packaged application artwork is unchanged.

**Key Characteristics:**

- One tile ground for the sidebar and conversation, white planes for the panel, sheets, cards, and composer.
- Hierarchy from ink, muted, and faint text, never from weight.
- Round controls: pills for buttons, chips, tracks, and send; 34px rows with r10 corners.
- Color only where it means something: diffs, results, attention dots, links, and selection.
- No keyboard shortcut hints and no capability advertising in the UI. The shortcuts themselves still work.

## Colors

The frontmatter records the OpenOrc palette in both modes; component entries show its light values. Components never use these literals. They read semantic roles from `app.css`, so every palette and saved custom color takes the same structure.

### Grounds and fills

`--bg` is the tile, painted as `var(--surface-gradient) fixed, var(--bg)` and kept opaque because the native window background follows it. `--surface` is the plane. `--surface-2` is the fill: hover for bare rows, ghost buttons, and menu items, and the resting fill of chips, tracks, fields, and file heads. `--surface-3` is the strong fill, kept for press, hover on controls that already rest on a fill, switch-off tracks, empty rings, disabled send, and meter tracks. `--line` appears only between rows, at `--hairline` width (half a pixel on high-density screens). In OpenOrc the fills and lines are translucent ink, so they read on tile and plane alike.

**The Contextual Fill Rule.** Selected rows paint `--current-row-fill` and secondary controls paint `--control-fill`. On the tile they are `--navigation-soft` and `--surface`. Every plane (`data-plane`, panel content, menus, dialogs, the composer) restates both as `--surface-2`, and a tile card inside a plane (settings cards, usage accounts, the memory control) restates them back to `--surface`. Mark new planes with `data-plane` instead of growing selector lists.

### Ink and accents

`--ink` is primary text. `--ink-2` and `--ink-3` are muted, the workhorse. `--ink-4` is faint, for meta, counts, and placeholders; it never sits on `--surface-3`. Every text role holds 4.5:1 on tile, plane, and fill. `--accent` and `--accent-fg` make the one ink pill. Selected and open rows keep `--navigation-ink`, links and inline code use `--content-ink`, so palette accents survive. `--ok` and `--bad` (with soft companions) mark diffs and results, `--attention` colors dots only, and `--warn` is the readable warning text.

Appearance mode and palette selection stay independent. OpenOrc has the values above, Cursor keeps its own grays, and flat light palettes have a hand-tuned ground step so planes still separate. Accent choices and custom colors persist per palette and mode; fill and line roles accept `#rrggbbaa`. Original Kamakura, Cyberpunk, and Eliron themes keep their authored treatment. [Theme references](../../docs/theme-references.md) separate source values from adaptations.

## Typography

Immaculate Gothic sets the whole interface by default, in its Text 450 face. Settings > Appearance can switch to Inter, Geist, or the system font; `fonts.css` maps the choice. Code has its own picker: JetBrains Mono Variable by default, Geist Mono Variable, or the system monospace, applied through the runtime `--font-mono` token to code blocks, editors, diffs, and open terminals.

The interface uses one weight: `--font-weight-medium` and `--font-weight-semibold` are both 400. Bold survives only for author emphasis inside content (replies, task documents, comments). UI text is 12, 13, or 14px; there is no 11px or 10px text. The scale, with its tracking, lives in `@theme static`:

- `xs` and `sm` 12/16, `base` 13/20, `md` 14/22, `lg` 16/22.
- `title-sm` 22/28 for document and page titles, `title` 28/34 for the New thread question and settings page titles.
- `stat` 18/22 and `stat-sm` 16/20 for numerals, always tabular.

Toolbar and thread titles are 13/16. Replies and prompts are 14/22. Single-line rows use 16px leading. Long prose wraps; code and tables scroll in their own blocks.

## Layout

The window has one navigation column, a conversation or destination, and an optional work panel. Toolbars are `max(44px, 32px / zoom)` and line up with the traffic lights at x16. 52px headers appear only inside cards and sheets; a card header that reaches native window controls drops to the 44px chrome line. The sidebar defaults to 272px, resizes from 224 to 380, and respects saved widths. The panel defaults to 640px within 340 to 900.

The conversation column is at most 800px with 32px reading gutters; the composer uses 24px. Both shrink to 12px at 520px and below and in narrow panes. Each column owns its scrolling. Split conversations keep their own header and panel ownership.

The sidebar paints nothing and has no seam. Its header holds Inbox (with its count), Search, and the sidebar toggle as 32px round buttons by the window controls. New thread, Tasks, Schedules, and More sit above the Threads/Orclings track; Add project and a round Settings button sit in the footer. While Settings is open, the sidebar lists its sections under Back to app.

Responsive rules:

- At 900px and narrower, the sidebar floats over the page as an opaque tile with `--shadow-overlay`, the only shadow left. Opening a destination dismisses it; switching Threads/Orclings keeps it open.
- At work-row widths of 788px or less, an open panel overlays the work area.
- New thread centers a 640px column; its composer bar wraps when the column narrows.

## Elevation & Depth

Depth is the fill step. Persistent surfaces have no borders and no shadows. Planes are one step from the tile, fills one step from their ground.

**The Floating Fill Rule.** Menus, popovers, tooltips, toasts, and dialogs have no border and no shadow. They paint `--float-fill`: the plane when the layer lands on the tile, the tile when it lands on a plane (`use-anchor-ground` sets `data-ground` on the portal). Dialogs also dim their backdrop.

**The Opaque Work Plane Rule.** Keep reading, writing, and tool content opaque when Transparent surroundings is on. The setting paints the shell tint once through `--shell-opacity`, from 0% (solid tint) to 100% (native blur), defaulting to 35%. System Reduce Transparency wins.

## Shapes

Corner radius is set per component:

- 6: labels and diff runs.
- 10: rows and menu items.
- 12: tall rows, sheet fields, and diff file heads.
- 14: the browser viewport.
- 16: drop menus, command, schedule, and toast cards, code blocks.
- 18: popovers, the inbox, the palette, prompt bubbles, permission, task, and MCP cards, settings cards.
- 20: the work panel, sheets, dialogs, grown menus (model, branch, context, slash), steps and question cards, the conversation composer.
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

Menus are r16 with 36px r10 rows, muted glyphs, and hairline separators. Grown menus (model, branch, mode) open out of their pill into an r20 layer. Tooltips are fill-step labels, opened once per group without a second delay.

### Sidebar

Threads/Orclings is a segmented track at natural width. A round search button grows into a capsule over the tabs, and the list's tool (filter, or New Orcling) follows it. More opens inline; Edit sidebar shows every screen with an eye switch. Project headings are 34px with a faint folder that opens while its threads show, and a faint meta ("Needs you", "2 running", "12 threads") that swaps with the plus on hover. Thread rows are 34px with muted titles; the open row takes `--current-row-fill` and `--navigation-ink`. A 16px status lead shows a question for needs you, a spinner, a failure, a 7px attention dot for unread, or the pull request mark. Running threads keep their faint second line.

### Conversation

The thread header holds the title in a rename box, a faint run of facts (project, account, activity, pull request, snooze), then Close pane, More, Tasks, and the panel toggle as round buttons. There are no Back/Forward buttons; their shortcuts still work.

User prompts are r18 plane bubbles, aligned right, capped at 88% of the column or 72ch, with no border. Replies are unboxed ink prose under a turn head (harness mark, agent, model, a status that swaps in place). Work collapses behind a receipt (thought time, steps, last check). The steps card is r20 with a 2px ink track when there is a plan; commands are r16 cards with their last output line; approvals are r18 cards, questions r20 with fill options. Changes close to one "Changed N files" line with a Review pill. Copy and Fork sit at the end of the turn, shown at rest only on the latest one. The cube still follows a finished reply.

### Composer

The conversation composer is one r20 surface on `--composer-input` with no inner well. One bar holds attach, the project or destination chip, model, and mode on the left, and activity, the context ring, and send on the right. Send, Queue, and Stop are layers of one 32px ink pill. The mode pill grows a small menu of the levels the agent offers; it does not step. Clicking the context ring opens its details; only Compact compacts. Below, one footer shows the working folder on the left and the branch chip and the Commit chip (Commit plus its +N −M totals) on the right. Queued messages stack as a pile that fans out on click.

New thread keeps the tile ground. Its toolbar holds only the panel toggle; the 28/34 question is the page title; the r24 white composer has a 15/24 prompt and a 34px send. The location sentence (Local checkout or Worktree) sits under it, starter pills below for an empty project draft, then "Pick up where you left off" rows.

### Work panel

The panel is one r20 plane card with an 8px margin on the tile, holding a 52px header and the open tab's page. Tabs sit on a fill track at natural width with a sliding knob; a tab's glyph becomes its close button on hover. Changes is always the first tab. The round plus opens the New tab page with tool and recent page rows. Each tool page starts with a 48px bar (title, faint meta, actions); Commit is that page's ink pill and grows into the r22 commit sheet. Diffs have 40px r12 fill file heads, 22px rows of 12px mono, `--ok` and `--bad` runs on soft fills with r6 ends, and no syntax colors. Web pages get a 44px bar with their own Back/Forward, an address pill, and an r14 inset viewport.

### Pages, tasks, and settings

Tasks, Pull requests, Schedules, Teams, and Memory share one header: the toolbar holds the page name, a round search that grows into a field, a filter menu, and the page's lg secondary create pill. Lists group under quiet headings (13px name, faint count, chevron on hover) in a 1120px column. Task rows are 44px r12, bare, with a fill hover, title in ink (muted for backlog and proposed), and a priority glyph in a fixed trailing slot. Schedules are r16 plane cards with a switch for Pause/Resume. The Inbox page keeps its route with 52px rows.

Settings is an r20 plane sheet beside the sidebar, which lists its sections. Each page has a 28/34 title and one faint line of context in a left-aligned 860px column. Groups and cards are tile cards on the sheet (r18, 20px inset), with hairlines between rows. Usage is a grid of r22 account cards; each limit is a 48px ring with the share used as a stat numeral, the label muted and the reset faint. Appearance tiles are fill-only with a navigation ring on the current choice.

**The Save Feedback Rule.** Announce actual saves and errors in place (Save becomes Saved with a check); leave the idle state empty.

**The Recovery Visibility Rule.** Keep actionable resets and unresolved attempts visible on the front of a usage card.

Agent and app update notices are r16 toasts in the upper-right stack with sm pills, a 3px progress track, and per-version Later. They cover the native Preview while visible. Details stay in [Interface conventions](../../docs/design-system.md).

## Do's and Don'ts

- Do read semantic roles and the contextual fills; never paste OpenOrc literals into components.
- Do keep one ink pill per screen and let everything else rest on fills.
- Do keep every existing control and saved state; restyle, don't remove.
- Do preserve saved widths, palettes, custom colors, keyboard access, native window clearance, drafts, and Orcling privacy.
- Don't add borders to persistent surfaces or shadows to floating layers.
- Don't use bold, 11px text, or faint text on the strong fill.
- Don't show shortcut hints or advertise what a control can do; reasons belong on disabled controls, on demand.
- Don't ship a control that does nothing.

Source authority is `src/renderer/src/app.css`, `workspace-design.css`, `settings-design.css`, `styles/*.css`, the theme modules, and the production components. The direction contract is the first HTML comment in `src/renderer/index.html`.

For a safe visual preview, run `pnpm preview:design` from the repository root and open `http://127.0.0.1:5177/?view=workspace&theme=light`. `OPENORC_PREVIEW_PORT` changes the port. The preview renders production components with synthetic providers and session-only settings; it does not verify live provider actions or real Orcling services.
