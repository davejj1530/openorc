import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Check,
  ChevronDown,
  Copy,
  Folder,
  GitBranch,
  GitPullRequest,
  Inbox,
  Laptop,
  ListFilter,
  ListTodo,
  LoaderCircle,
  MoreHorizontal,
  PanelLeft,
  PanelRight,
  PenSquare,
  Plus,
  Search,
  Settings,
  Sparkles,
  Workflow,
} from "./icons";
import { ChangesShoulder } from "./ChangesShoulder";
import { HarnessLogo } from "./HarnessLogo";
import openOrcMark from "../assets/openorc-mark.png";
import { cn } from "../lib/cn";
import { themePresets, type Mode, type ThemePreset } from "../lib/theme-palettes";
import { overridesFor, type CustomColors } from "../lib/theme-custom";
import "./PaletteSelector.css";

export function PaletteSelector({ preset, mode, custom, onChange }: { preset: ThemePreset; mode: Mode; custom: CustomColors; onChange: (preset: ThemePreset) => void }) {
  const selected = themePresets.find((theme) => theme.id === preset)!;
  const colors = { ...selected.colors[mode], ...overridesFor(custom, preset, mode) };
  return (
    <div className="palette-selector">
      <div className="palette-choices" role="group" aria-label="Color palette">
        {themePresets.map((theme) => (
          <button className="palette-choice" type="button" key={theme.id} aria-label={`${theme.name} palette`} aria-pressed={preset === theme.id} onClick={() => onChange(theme.id)}>
            <span className="palette-choice-name">{theme.name}</span>
            <span className="palette-swatches" style={{ ...theme.colors[mode], ...overridesFor(custom, theme.id, mode) } as CSSProperties} aria-hidden="true">
              <i />
              <i />
              <i />
              <i />
              <i />
            </span>
            <Check className="palette-choice-check" size={14} aria-hidden="true" />
          </button>
        ))}
      </div>
      <figure className="palette-sample" aria-label={`${selected.name} workspace preview`}>
        <WorkspaceScene colors={colors} mode={mode} />
        <figcaption className="palette-sample-caption">
          <span>
            <strong>{selected.name}</strong>
            <span>{selected.description}</span>
          </span>
          <span>{mode === "dark" ? "Dark" : "Light"} preview</span>
        </figcaption>
      </figure>
    </div>
  );
}

/** The window width the scene is laid out at. Narrower columns show the same window, smaller. */
const SCENE_WIDTH = 800;

/**
 * A still of the thread workspace in the chosen palette: the sidebar, a conversation, and the
 * composer holding uncommitted work. The markup borrows the shell's own classes wherever a
 * class paints on its own, so the preview follows the product as the product changes.
 */
function WorkspaceScene({ colors, mode }: { colors: Record<string, string>; mode: Mode }) {
  const { ref, scale } = useFitScale(SCENE_WIDTH);
  return (
    <div className="palette-stage" ref={ref}>
      <div className="palette-workspace" style={{ ...colors, zoom: scale } as CSSProperties} data-preview-mode={mode} aria-hidden="true">
        <aside className="palette-sidebar">
          <WindowNavScene />
          <div className="palette-brand">
            <img src={openOrcMark} alt="" className="sidebar-brand-mark" />
            <span className="sidebar-wordmark">OpenOrc</span>
            <IconSlot className="sidebar-brand-new-thread">
              <PenSquare size={17} />
            </IconSlot>
          </div>
          <nav className="palette-nav">
            <NavRow icon={<ListTodo size={15} />} label="Tasks" />
            <NavRow icon={<GitPullRequest size={15} />} label="Pull requests" />
            <NavRow icon={<Workflow size={15} />} label="Orchestration" />
            <NavRow icon={<MoreHorizontal size={15} />} label="More" />
          </nav>
          <div className="palette-projects">
            <span>Projects</span>
            <IconSlot size="sm">
              <ListFilter size={13} />
            </IconSlot>
            <IconSlot size="sm">
              <Plus size={14} />
            </IconSlot>
          </div>
          <div className="palette-project">
            <div className="palette-project-name">
              <Folder size={14} />
              <span>studio</span>
              <ChevronDown size={12} />
            </div>
            <div className="palette-thread-rows">
              <ThreadRow title="Make the first five minutes count" agent="codex" current />
              <ThreadRow title="A faster command menu" agent="claude" working />
            </div>
          </div>
          <div className="palette-sidebar-foot">
            <NavRow icon={<Settings size={15} />} label="Settings" />
          </div>
        </aside>
        <main className="palette-plane">
          <header className="palette-topbar">
            <span className="palette-topbar-title">Make the first five minutes count</span>
            <span className="header-chip">
              <span>studio</span>
              <ChevronDown size={12} />
            </span>
            <span className="palette-topbar-actions">
              <IconSlot>
                <MoreHorizontal size={15} />
              </IconSlot>
              <IconSlot>
                <PanelRight size={15} />
              </IconSlot>
            </span>
          </header>
          <div className="palette-transcript">
            <div className="palette-user">
              <div className="message-bubble">Let’s make onboarding feel more thoughtful. Help people connect their first project, then give them a clear next step.</div>
            </div>
            <div className="palette-reply prose-chat">
              <p>The welcome flow is ready to review.</p>
              <ul>
                <li>
                  <strong>A real welcome.</strong> A short introduction gives people a place to start.
                </li>
                <li>
                  <strong>One clear next step.</strong> Connect a project, then open a conversation.
                </li>
              </ul>
              <div className="palette-reply-meta">
                <span>1m ago</span>
                <Copy size={13} />
              </div>
            </div>
            <span className="agent-orb">
              <Sparkles size={16} className="tool-icon" data-tone="think" />
            </span>
          </div>
          <div className="composer palette-composer">
            <div className="composer-changes">
              <ChangesShoulder />
              <div className="composer-changes-body">
                <div className="composer-changes-identity">
                  <span className="composer-changes-project">studio</span>
                  <span className="composer-changes-branch">
                    <GitBranch size={14} />
                    <span>main</span>
                  </span>
                </div>
                <span className="composer-changes-summary">
                  <span className="text-ok">+8</span>
                  <span className="text-bad">−2</span>
                </span>
                <span className="composer-changes-commit">Commit changes</span>
              </div>
            </div>
            <div className="composer-shell border">
              <div className="composer-input-shell">
                <div className="composer-input palette-composer-placeholder">Message Codex…</div>
              </div>
              <div className="composer-foot">
                <div className="composer-lead">
                  <span className="composer-icon-button">
                    <Plus size={16} />
                  </span>
                </div>
                <div className="composer-meta">
                  <span className="composer-location">
                    <Laptop size={14} />
                    <span>Local checkout</span>
                  </span>
                  <span className="composer-picker">
                    <span className="composer-picker-value">Review changes</span>
                    <ChevronDown size={14} />
                  </span>
                </div>
                <div className="composer-actions">
                  <span className="composer-model-trigger">
                    <HarnessLogo id="codex" size={14} />
                    <span className="composer-model-name">GPT-6-Astra</span>
                    <span className="composer-model-effort">High</span>
                    <ChevronDown size={14} />
                  </span>
                  <span className="composer-send">
                    <ArrowUp size={16} />
                  </span>
                </div>
              </div>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}

/** The sidebar's header as the app draws it: sidebar toggle, inbox with its count, search and history. */
function WindowNavScene() {
  return (
    <div className="palette-window-nav">
      <IconSlot>
        <PanelLeft size={15} />
      </IconSlot>
      <IconSlot>
        <span className="palette-inbox">
          <Inbox size={15} />
          <span className="nav-badge">2</span>
        </span>
      </IconSlot>
      <IconSlot>
        <Search size={15} />
      </IconSlot>
      <IconSlot>
        <ArrowLeft size={15} />
      </IconSlot>
      <IconSlot muted>
        <ArrowRight size={15} />
      </IconSlot>
    </div>
  );
}

function IconSlot({ children, className, size = "md", muted }: { children: ReactNode; className?: string; size?: "sm" | "md"; muted?: boolean }) {
  return <span className={cn("palette-icon-slot", size === "sm" && "palette-icon-slot-sm", muted && "palette-icon-slot-muted", className)}>{children}</span>;
}

function NavRow({ icon, label }: { icon: ReactNode; label: string }) {
  return (
    <span className="palette-nav-row">
      <span>{icon}</span>
      <span>{label}</span>
    </span>
  );
}

function ThreadRow({ title, agent, current, working }: { title: string; agent: "codex" | "claude"; current?: boolean; working?: boolean }) {
  return (
    <span className="palette-thread-row" data-current={current || undefined}>
      <span className="palette-thread-title">
        <span>{title}</span>
        {working ? <LoaderCircle size={14} /> : null}
      </span>
      <span className="palette-thread-meta">
        <span>
          <GitBranch size={11} />
          <span>main</span>
        </span>
        <span>
          <HarnessLogo id={agent} size={12} />
          <span>{agent === "codex" ? "Codex" : "Claude"}</span>
        </span>
      </span>
    </span>
  );
}

/** Zoom the scene down to the column it sits in, keeping the layout at its design width. */
function useFitScale(width: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      // Floor so the zoomed scene never lands a fraction of a pixel wider than its stage.
      setScale(Math.min(1, Math.floor((entry!.contentRect.width / width) * 1000) / 1000));
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [width]);
  return { ref, scale };
}
