---
name: OpenOrc desktop
description: A neutral multi-project workspace with compact conversations and inset work panels.
colors:
  action-light: "#2865c2"
  action-dark: "#2f6cc8"
  accent-text-light: "#2159a0"
  accent-text-dark: "#a8ccff"
  on-action: "#ffffff"
  navigation-soft-light: "#e8f0fa"
  navigation-soft-dark: "#27374b"
  sidebar-light: "#f3f3f3"
  sidebar-dark: "#1b1b1b"
  canvas-light: "#f7f7f7"
  canvas-dark: "#202020"
  paper-light: "#ffffff"
  paper-dark: "#252525"
  raised-light: "#efefef"
  raised-dark: "#2b2b2b"
  border-light: "#e1e1e1"
  border-dark: "#3a3a3a"
  ink-light: "#303030"
  ink-dark: "#f0f0f0"
typography:
  interface:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif'
    fontSize: "13px"
    fontWeight: 400
    lineHeight: "20px"
  title:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif'
    fontSize: "13px"
    fontWeight: 600
    lineHeight: "20px"
    letterSpacing: "-0.15px"
  body:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif'
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.6
  composer:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif'
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.6
  label:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif'
    fontSize: "12px"
    fontWeight: 400
    lineHeight: "18px"
  document:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif'
    fontSize: "30px"
    fontWeight: 500
    lineHeight: 1.16
    letterSpacing: "-0.9px"
  code:
    fontFamily: '"JetBrains Mono Variable", "SF Mono", Menlo, Consolas, monospace'
  cursor-interface:
    fontFamily: '"Inter Variable", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
rounded:
  sm: "5px"
  compact: "6px"
  navigation: "7px"
  md: "8px"
  composer: "11px"
  lg: "12px"
  panel: "14px"
  xl: "16px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  panel-inset: "12px"
  reading-gutter: "16px"
  section: "24px"
  task-gutter: "40px"
components:
  button-primary:
    backgroundColor: "{colors.action-light}"
    textColor: "{colors.on-action}"
    typography: "{typography.interface}"
    rounded: "{rounded.md}"
    padding: "0 10px"
    height: "28px"
  button-secondary:
    backgroundColor: "{colors.raised-light}"
    textColor: "{colors.ink-light}"
    typography: "{typography.interface}"
    rounded: "{rounded.md}"
    padding: "0 10px"
    height: "28px"
  button-ghost:
    backgroundColor: "transparent"
    typography: "{typography.interface}"
    rounded: "{rounded.md}"
    padding: "0 10px"
    height: "28px"
  button-danger:
    backgroundColor: "{colors.canvas-light}"
    typography: "{typography.interface}"
    rounded: "{rounded.md}"
    padding: "0 10px"
    height: "28px"
  thread-filter:
    backgroundColor: "transparent"
    typography: "{typography.label}"
    rounded: "{rounded.compact}"
    padding: "0 8px"
    height: "28px"
  navigation-selected:
    backgroundColor: "{colors.navigation-soft-light}"
    textColor: "{colors.accent-text-light}"
    typography: "{typography.label}"
    rounded: "{rounded.navigation}"
    padding: "0 12px"
    height: "28px"
  task-filter-selected:
    backgroundColor: "{colors.navigation-soft-light}"
    textColor: "{colors.accent-text-light}"
    typography: "{typography.label}"
    rounded: "{rounded.compact}"
    padding: "0 10px"
    height: "28px"
  user-prompt:
    backgroundColor: "{colors.paper-light}"
    textColor: "{colors.ink-light}"
    rounded: "{rounded.lg}"
    padding: "10px 12px"
  composer-shell:
    backgroundColor: "{colors.raised-light}"
    rounded: "{rounded.composer}"
    padding: "{spacing.xs}"
  work-panel:
    backgroundColor: "{colors.paper-light}"
    rounded: "{rounded.panel}"
---

# Design System: OpenOrc desktop

## Overview

**Creative North Star: "A calm place to think with coding agents"**

OpenOrc is a compact desktop workspace for several projects at once. A shared sidebar keeps projects and conversations visible; the conversation occupies the center, and an optional work panel holds review and tools. The approved Cursor-inspired composition uses neutral gray, white, or charcoal grounds with blue accents in the OpenOrc palette. The Cursor palette uses the same structure with monochrome accents.

This record describes the built desktop interface. It preserves the workflows in [PRODUCT.md](../../PRODUCT.md), including drafts, task authorization, Orcling privacy, and project context. Packaged application artwork is unchanged.

**Key Characteristics:**

- One resizable sidebar with expandable project groups and Threads/Orclings tabs.
- Compact toolbar titles, bounded user prompts, and unboxed assistant responses.
- Flat neutral surfaces, a distinct writing area, and an inset work panel.
- Independent action, navigation, and content accents across saved palettes.
- Existing keyboard controls, window chrome, split panes, and recovery states remain available.

## Colors

The frontmatter records the OpenOrc palette in both appearances; component entries show its light defaults. Runtime semantic variables remain authoritative for other palettes and user overrides.

### Primary

Blue is used for actions, selected navigation, and reading accents. Use `--accent` and its foreground, text, and tint companions for actions; `--navigation-ink` and `--navigation-soft` for active views, threads, and filters; and `--content-ink` and `--content-soft` for links, inline code, and conversation markers. Solid blue action fills keep white labels. Success, attention, review, destructive feedback, and diff meaning retain separate status roles.

### Neutral

`--bg` supplies the sidebar, `--surface` the conversation canvas, `--paper` the work panel, and `--surface-2` raised controls and the composer shell. `--composer-input` independently supplies the writing area. OpenOrc light uses white paper and writing areas; dark uses a lighter charcoal work surface inside a slightly brighter composer shell. Fine borders and the ink hierarchy distinguish adjacent surfaces. Cursor keeps this geometry with its own neutral values and Inter typography.

**The Semantic Color Rule.** Read live palette roles instead of hardcoding OpenOrc colors into components.

Appearance mode and palette selection remain independent. Accent choices and fine-grained custom colors persist per palette and light/dark mode. Editing or resetting Actions preserves Content and its selection color; resetting all accents preserves unrelated surface and text overrides. Paper and writing-area roles are editable and have fallbacks for every palette. Other presets may retain dark work-plane gradients; OpenOrc and Cursor grounds stay flat.

## Typography

System sans-serif is the default throughout the app, including task and welcome headings. Cursor switches the interface to Inter Variable. Code uses JetBrains Mono Variable with platform monospace fallbacks.

The frontmatter defines the observed hierarchy. Toolbar titles use the compact semibold title role. Ordinary controls use the interface or label role; conversation prose uses the body role, while the composer has its own smaller text. Task page headings use the document role. New-thread welcome headings scale from (28px) to (36px). Dates, counts, usage, and diff statistics use tabular numerals.

Thread rows have single-line titles with ellipsis. Provider and branch details remain in accessible labels and hover text. Long prose wraps; code and tables may scroll within their own containers.

## Layout

The desktop frame has one shared navigation column, a conversation or destination pane, and an independent optional work panel. There is no separate icon rail. Navigation defaults to (267px), resizes from (224px) to (380px), and respects saved widths. The work panel defaults to (640px), with saved widths clamped between (340px) and (900px). Toolbars are (40px) at normal zoom and preserve native window-control clearance at other zoom levels.

The sidebar orders New thread and app destinations above Threads/Orclings tabs, followed by the active list. Threads keeps Workspace and imported projects together in expandable groups, each with its own new-thread action. Project options reserve a fixed (24px) slot so revealing them never moves the adjacent plus button. Add project, Settings, Inbox, and history controls occupy the footer. Hidden destinations remain available through More → Edit sidebar. When the sidebar is closed, window navigation and search remain in the main toolbar.

The conversation measure is at most (800px), with (16px) reading gutters. The right work panel is inset (12px) from its sides and bottom. Each column owns its scrolling. Sidebar and panel resizing support dragging, keyboard input, and reset. Split conversations retain their own toolbar and panel ownership.

Responsive rules follow the available space:

- At viewport widths of (900px) or less, navigation becomes an overlay. Selecting a conversation or destination dismisses it; switching Threads/Orclings keeps the list open.
- At work-row widths of (788px) or less, an open work panel overlays the work area. It can still expand independently.
- At composer widths of (440px) or less, action controls move to a second row and wrap.
- At viewport widths of (520px) or less, reading gutters shrink to (12px) and new-thread recent items use one column.
- Settings retains its horizontal category toolbar and maximum (960px) content width. Preference rows stack below an (800px) container; usage rows reflow below (540px).

## Elevation & Depth

Persistent surfaces stay flat. Tonal fills, spacing, typography, and fine borders separate the sidebar, canvas, user prompts, composer, and work panel. App-scoped material tokens remove cast and inset shadows from persistent surfaces. Menus, popovers, dialogs, and temporary overlays retain their existing floating shadow roles.

**The Opaque Work Plane Rule.** Keep reading, writing, and tool content opaque when Transparent surroundings is enabled.

The optional native-blur setting paints the surrounding shell tint once through `--shell-opacity`. Its slider ranges from (0%) solid palette tint to (100%) native blur without tint and defaults to (35%). The saved level survives toggling the setting off and on. System Reduce Transparency takes precedence. Preserve solid palette tokens so custom colors and previews continue to work.

## Shapes

Compact controls use the shared small and medium radii. Navigation rows and browser tabs use the navigation radius; the composer pairs its outer radius with a smaller writing area. User prompts use the large radius and a fine border. Inset work panels use the panel radius; diff files inside them use the medium radius. These boundaries carry structure without stacked shadows.

New app icons follow the [Precision Outline family](../../docs/precision-outline-icons.md): original Codex-generated geometry on a (24-unit) grid with (1.75-unit) strokes, rounded joins and caps, and `currentColor`. Reuse shared icon components and accessible names. Filled collaboration-status marks, the original Hollow conversation indicator, and bundled upstream framework/language logos remain deliberate exceptions. Individual Orclings retain their own shapes and colors.

## Components

### Buttons, fields, and filters

Use the shared Button, IconButton, input, menu, dialog, and segmented-control primitives. Buttons offer primary, secondary, ghost, and danger variants; default controls are (28px) high, with (24px) and (32px) sizes. Routine toolbar actions use quiet icon buttons with accessible names and tooltips. Primary actions use the action role, secondary actions use neutral raised fills, and destructive actions retain their semantic styling.

Text fields indicate focus with a surface/caret change and no ring or shadow. Buttons, tabs, swatches, and disclosures retain visible keyboard focus. Task filters have separate padded targets and a soft selected fill; generic segmented controls retain transparent resting backgrounds and text emphasis.

### Navigation and Orclings

The thread browser retains loaded-title filtering, active/archived and pinned views, per-project pagination, collapsed sections, status, and context menus. Opening a thread does not hide other projects. Command-click or Control-click opens a split pane. Collapsed projects retain known Running or Needs you activity. Project icons still support discovery, explicit choice, refresh, and removal through existing controls.

Threads and Orclings share the sidebar through tabs and remember their last selected conversations. Orcling home chats stay out of project thread lists. Their private instructions and memory remain separate from Workspace and project memory. Real companion chat, profile, and designer routes preserve existing permissions. Generic agent presence is a single-color face; thinking uses a restrained opacity pulse that reduced motion disables.

### Conversation and composer

User prompts have a quiet bordered surface and no repeated author heading. Copy, Fork, and timestamp controls sit in a reserved row below the prompt, so revealing them on hover or focus does not overlap the bubble or move content. Assistant responses are unboxed with a compact author line; named team replies keep one avatar/name/model/time line. The editable thread title and contextual tools share the top toolbar. Team revision details, activity visibility, and context compaction remain in the team menu, with pending compaction identifiable on its trigger.

The composer uses a neutral raised shell around a distinct writing area, followed by compact mode, model/effort, context, and send controls. Mode and model controls rest on transparent backgrounds. The effort knob stays white; its fill ends at the thumb center, pointer motion snaps smoothly, and keyboard input moves between stops. Clicking context usage opens details; only its explicit action compacts context. An empty running composer shows Stop; text or attachments restore Send with a separate Stop control. Git context stays in the composer, with the branch shown once and the working-folder path below.

Work-panel tabs keep their full names at every panel width. The strip uses available space and scrolls horizontally only when its tabs no longer fit; add-tool, expand, and hide actions stay reachable alongside it. Clicking a web link reveals Preview and selects its tab, including when the panel was closed or showing another tool. The address and loading or error state remain visible while the page opens.

### Tasks, settings, and recovery

Tasks use the compact window toolbar for their title, project scope, and New task action. One filter row holds Active/Done/Archived, a status selector with counts, and search; it wraps at narrow widths. The grouped list starts immediately below, with 46px rows, keyboard navigation, and status menus. Saving a task to backlog and starting its work are separate actions. Drafts survive navigation. Starter prompts prepare an editable plan and never send automatically.

Settings uses flat preference groups and a 40px row of text categories below the window toolbar. Categories keep their natural width and scroll horizontally in narrow windows; arrow keys, Home, and End select and reveal each section. Palette changes update the app live. Usage is an account ledger: each allowance shows its reported remaining or used amount, a thin meter, and reset timing. Missing, stale, and failed reports remain explicit; provider details and local activity stay separate.

**The Save Feedback Rule.** Announce actual saves and errors in normal document flow; leave the idle state empty.

**The Recovery Visibility Rule.** Keep actionable resets and unresolved attempts visible. Preserve the reset attempt's state when the provider inventory changes.

Agent and OpenOrc release notices share the upper-right workspace stack. Preserve explicit update/download/restart actions, readable progress and errors, per-version Later persistence, and Preview-covering behavior while notices are visible. Detailed update, project-icon, and transparency conventions remain in [Interface conventions](../../docs/design-system.md).

## Do's and Don'ts

- Do keep neutral OpenOrc and Cursor grounds with accents on controls, selection, and content.
- Do preserve saved widths, palettes, custom colors, independent accent roles, and semantic statuses.
- Do preserve native window-control clearance, keyboard access, private Orcling memory, drafts, and existing workflows.
- Do keep project actions stationary on hover and composer controls reachable in narrow columns.
- Don't reintroduce a separate icon rail, blue-tinted OpenOrc grounds, or serif task headings.
- Don't turn synthetic preview identities, activity, or account data into product claims.

Source authority is `src/renderer/src/workspace-design.css`, `app.css`, `settings-design.css`, the theme modules, and the production components. The direction contract is the first HTML comment in `src/renderer/index.html`. The companion `.impeccable/design.json` extends these tokens with component examples, motion, and responsive metadata.

For a safe visual preview, run `pnpm preview:design` from the repository root and open `http://127.0.0.1:5177/?design=1&theme=light&accent=default`. `OPENORC_PREVIEW_PORT` changes the port. The preview renders production components with synthetic providers and session-only settings; it does not verify live provider actions or real Orcling services. Review captures live in the ignored repository `.impeccable/review/` directory.
