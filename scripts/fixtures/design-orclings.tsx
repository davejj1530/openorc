/** Interactive profile design study using production Orcling artwork and sample data.
 * Sample identities, messages, and edits stay in memory. No Orcling RPC is called. */
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { OrclingLook, PermissionPreset, RunMode } from "@openorc/protocol";
import { Composer } from "../../apps/desktop/src/renderer/src/components/Composer";
import { WorkspaceRail } from "../../apps/desktop/src/renderer/src/components/WorkspaceRail";
import { SidebarToggle } from "../../apps/desktop/src/renderer/src/components/Sidebar";
import { ResizeHandle } from "../../apps/desktop/src/renderer/src/components/ResizeHandle";
import { TopBar } from "../../apps/desktop/src/renderer/src/components/TopBar";
import { TranscriptContents } from "../../apps/desktop/src/renderer/src/components/Transcript";
import { Button, IconButton } from "../../apps/desktop/src/renderer/src/components/ui";
import { ArrowLeft, ArrowUpRight, Check, Plus, Search, Settings } from "../../apps/desktop/src/renderer/src/components/icons";
import { useLayout } from "../../apps/desktop/src/renderer/src/lib/layout";
import { useRouter } from "../../apps/desktop/src/renderer/src/lib/router";
import { dismissCompactNavigation } from "../../apps/desktop/src/renderer/src/lib/compact-navigation";
import { OrclingsRailContext } from "../../apps/desktop/src/renderer/src/lib/orclings-rail";
import type { ModelChoice } from "../../apps/desktop/src/renderer/src/lib/model-picker-selection";
import { OrclingStill } from "../../apps/desktop/src/renderer/src/components/OrclingAvatar";
import { ORCLING_SHAPES, ORCLING_BODY_COLORS, ORCLING_EYES, ORCLING_GLASSES, ORCLING_ACCESSORIES, ORCLING_TEXTURES } from "../../apps/desktop/src/renderer/src/components/orcling-art";
import "./design-orclings.css";

type Companion = { id: string; name: string; look: OrclingLook; model: ModelChoice; permission: PermissionPreset; instructions: string; preview: string };
const baseLook = { shape: 0, eyes: 0, texture: 0, glasses: 0, accessory: 0, bodyColor: "#52b8a0", eyeColor: "#1b1c20" };
const codex: ModelChoice = { agent: "codex", model: "gpt-6-astra", effort: "high", fastMode: false };
const samples: Companion[] = [
  {
    id: "orcling-rini",
    name: "Rini",
    look: baseLook,
    model: codex,
    permission: "review",
    instructions: "Help me turn rough ideas into clear next steps. Keep replies thoughtful and concise. Ask before making changes, and remember the decisions we make together.",
    preview: "We can start with the welcome flow.",
  },
  {
    id: "orcling-atlas",
    name: "Atlas",
    look: { ...baseLook, shape: 10, bodyColor: "#4f7bf2", glasses: 1 },
    model: codex,
    permission: "review",
    instructions: "Help me understand how the pieces fit together. Explain tradeoffs clearly and keep implementation plans practical.",
    preview: "The smaller module keeps this simpler.",
  },
  {
    id: "orcling-pip",
    name: "Pip",
    look: { ...baseLook, shape: 5, bodyColor: "#ec7ba8", eyes: 2, accessory: 1 },
    model: codex,
    permission: "review",
    instructions: "Review the details with me. Look for confusing interactions, unclear language, and small improvements that make work easier.",
    preview: "I have a few notes on the details.",
  },
];

export function DesignOrclings({ children }: { children: ReactNode }) {
  const route = useRouter((state) => state.route);
  const [companions, setCompanions] = useState(samples);
  const [profile, setProfile] = useState(false);
  const [search, setSearch] = useState("");
  const open = useLayout((state) => state.sidebarOpen);
  const current = route.view === "thread" ? companions.find((item) => item.id === route.threadId) : undefined;
  const lastOrcling = useRef(samples[0]!.id);
  const lastThread = useRef("onboarding");
  useEffect(() => {
    if (current) lastOrcling.current = current.id;
    else if (route.view === "thread") lastThread.current = route.threadId;
  }, [current, route]);
  const navigation = {
    active: Boolean(current),
    open: () => {
      setProfile(false);
      setSearch("");
      useRouter.getState().navigate({ view: "thread", threadId: lastOrcling.current });
      useLayout.setState({ sidebarOpen: true });
    },
  };
  if (!current) return <OrclingsRailContext.Provider value={navigation}>{children}</OrclingsRailContext.Provider>;
  const choose = (id: string) => {
    setProfile(false);
    useRouter.getState().navigate({ view: "thread", threadId: id });
    dismissCompactNavigation();
  };
  const update = (patch: Partial<Companion>) => setCompanions((items) => items.map((item) => (item.id === current.id ? { ...item, ...patch } : item)));
  const add = () => {
    const next = { ...samples[0]!, id: `orcling-${Date.now()}`, name: "New Orcling", preview: "Start a conversation." };
    setCompanions((items) => [...items, next]);
    useRouter.getState().navigate({ view: "thread", threadId: next.id });
    setProfile(true);
    dismissCompactNavigation();
  };
  return (
    <OrclingsRailContext.Provider value={navigation}>
      <div className="app-shell orcling-study h-full flex text-ink">
        <aside className="sidebar-shell workspace-navigation h-full shrink-0" data-open={open} data-browsing="true" aria-hidden={!open} inert={!open}>
          <WorkspaceRail
            route={route}
            projectId={null}
            onProject={(id) => {
              useLayout.getState().setProject(id);
              choose(id === "website" ? "welcome" : "onboarding");
            }}
            onThreads={() => {
              useRouter.getState().navigate({ view: "thread", threadId: lastThread.current });
              useLayout.setState({ sidebarOpen: true });
            }}
          />
          <section className="conversation-browser" aria-label="Orclings">
            <header className="browser-toolbar drag-region h-topbar">
              <span className="browser-close">
                <SidebarToggle open />
              </span>
              <span>Orclings</span>
              <IconButton aria-label="New Orcling" onClick={add}>
                <Plus size={16} />
              </IconButton>
            </header>
            <div className="browser-heading">
              <h2>Your Orclings</h2>
              <p>A conversation with each companion</p>
            </div>
            <div className="browser-controls">
              <label className="browser-search">
                <Search size={14} />
                <input aria-label="Find an Orcling" placeholder="Find an Orcling…" value={search} onChange={(event) => setSearch(event.target.value)} />
              </label>
            </div>
            <div className="browser-threads">
              {companions
                .filter((item) => item.name.toLowerCase().includes(search.toLowerCase()))
                .map((item) => (
                  <button key={item.id} className="orcling-contact" aria-current={item.id === current.id ? "page" : undefined} onClick={() => choose(item.id)}>
                    <OrclingStill look={item.look} size={38} />
                    <span>
                      <strong>{item.name}</strong>
                      <small>{item.preview}</small>
                    </span>
                  </button>
                ))}
              {!companions.some((item) => item.name.toLowerCase().includes(search.toLowerCase())) ? <p className="browser-empty">No matching Orclings.</p> : null}
            </div>
            <p className="browser-hint">Each Orcling keeps its own instructions and memory.</p>
          </section>
        </aside>
        {open ? <ResizeHandle edge="sidebar" /> : null}
        <main className="workspace-main well flex-1 min-w-0 flex flex-col">
          <TopBar
            windowDragSurface
            showProject={false}
            actions={
              <Button variant="ghost" size="sm" onClick={() => setProfile(!profile)}>
                {profile ? <ArrowLeft size={14} /> : <Settings size={14} />}
                {profile ? "Conversation" : "Profile"}
              </Button>
            }
          >
            <OrclingStill look={current.look} size={23} />
            <h1 className="thread-rail-title">{current.name}</h1>
          </TopBar>
          {profile ? <OrclingProfile key={current.id} companion={current} onChange={update} /> : <OrclingChat key={current.id} companion={current} onChange={update} />}
        </main>
      </div>
    </OrclingsRailContext.Provider>
  );
}

function OrclingChat({ companion, onChange }: { companion: Companion; onChange: (patch: Partial<Companion>) => void }) {
  const [draft, setDraft] = useState("");
  const [sent, setSent] = useState<string[]>([]);
  const [mode, setMode] = useState<RunMode>("act");
  return (
    <>
      <div className="orcling-chat-scroll">
        <div className="orcling-chat-document">
          <p className="orcling-conversation-date">Today</p>
          <TranscriptContents
            runId="orcling-study"
            taskCards={false}
            blocks={[{ kind: "message", id: "hello", role: "user", text: "Help me make the first five minutes of OpenOrc feel more thoughtful.", streaming: false }]}
          />
          <section className="orcling-chat-reply" aria-label={`${companion.name}'s reply`}>
            <header>
              <OrclingStill look={companion.look} size={26} />
              <strong>{companion.name}</strong>
              <time>Just now</time>
            </header>
            <p>Let’s give people a clear place to begin. We can start with the welcome flow, then work through the smaller details together.</p>
            <p>I’d keep the first screen focused on connecting a project and starting a conversation. Everything else can appear when it becomes useful.</p>
            <button className="orcling-project-link" onClick={() => useRouter.getState().navigate({ view: "thread", threadId: "onboarding" })}>
              <span>studio</span>
              <strong>Make the first five minutes count</strong>
              <span className="inline-flex items-center gap-1">
                Open conversation <ArrowUpRight size={12} />
              </span>
            </button>
          </section>
          {sent.map((text, index) => (
            <TranscriptContents key={index} runId="orcling-study" taskCards={false} blocks={[{ kind: "message", id: `sent-${index}`, role: "user", text, streaming: false }]} />
          ))}
          {sent.length ? (
            <p className="orcling-preview-feedback" role="status">
              Message added to this preview. No agent was contacted.
            </p>
          ) : null}
        </div>
      </div>
      <div className="composer-padding shrink-0">
        <div className="max-w-chat mx-auto">
          <Composer
            value={draft}
            onChange={setDraft}
            onSubmit={async (text) => {
              setSent((messages) => [...messages, text]);
              setDraft("");
            }}
            draftKey={`design.${companion.id}`}
            placeholder={`Message ${companion.name}…`}
            model={companion.model}
            onModel={(model) => onChange({ model })}
            mode={mode}
            onMode={setMode}
            permission={companion.permission}
            onPermission={(permission) => onChange({ permission })}
            location={{ label: null, branch: null }}
            attachmentsDisabledReason="Attachments are unavailable in this sample conversation."
          />
        </div>
      </div>
    </>
  );
}

const profileTabs = ["Appearance", "Instructions", "Memory"] as const;
function moveRadio(event: KeyboardEvent<HTMLDivElement>) {
  if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
  const choices = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]'));
  const index = choices.findIndex((choice) => choice === event.target);
  if (index < 0) return;
  event.preventDefault();
  const offset = ["ArrowLeft", "ArrowUp"].includes(event.key) ? -1 : 1;
  let next = (index + offset + choices.length) % choices.length;
  if (event.key === "Home") next = 0;
  if (event.key === "End") next = choices.length - 1;
  choices[next]?.focus();
  choices[next]?.click();
}
function OrclingProfile({ companion, onChange }: { companion: Companion; onChange: (patch: Partial<Companion>) => void }) {
  const [tab, setTab] = useState<(typeof profileTabs)[number]>("Appearance");
  const [instructions, setInstructions] = useState(companion.instructions);
  const [originalInstructions] = useState(companion.instructions);
  const [feedback, setFeedback] = useState("");
  const look = (patch: Partial<OrclingLook>) => onChange({ look: { ...companion.look, ...patch } });
  return (
    <div className="orcling-profile-scroll">
      <div className="orcling-profile-document">
        <header className="orcling-profile-identity">
          <OrclingStill look={companion.look} size={100} />
          <div>
            <label htmlFor="orcling-name">Name</label>
            <input id="orcling-name" value={companion.name} maxLength={40} onChange={(event) => onChange({ name: event.target.value })} />
            <p>The same companion across your conversations and projects.</p>
          </div>
        </header>
        <div className="orcling-profile-tabs" role="tablist" aria-label="Profile sections">
          {profileTabs.map((name, index) => (
            <button
              key={name}
              id={`orcling-tab-${name}`}
              role="tab"
              tabIndex={tab === name ? 0 : -1}
              aria-selected={tab === name}
              aria-controls="orcling-profile-content"
              onClick={() => setTab(name)}
              onKeyDown={(event) => {
                if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
                event.preventDefault();
                const next = profileTabs[(index + (event.key === "ArrowRight" ? 1 : 2)) % 3]!;
                setTab(next);
                document.getElementById(`orcling-tab-${next}`)?.focus();
              }}
            >
              {name}
            </button>
          ))}
        </div>
        <section id="orcling-profile-content" role="tabpanel" aria-labelledby={`orcling-tab-${tab}`}>
          {tab === "Appearance" ? (
            <>
              <div className="orcling-profile-section">
                <h2>Shape</h2>
                <div className="orcling-shape-options" role="radiogroup" aria-label="Shape" onKeyDown={moveRadio}>
                  {ORCLING_SHAPES.map((shape, index) => (
                    <button
                      key={shape.name}
                      role="radio"
                      tabIndex={companion.look.shape === index ? 0 : -1}
                      aria-checked={companion.look.shape === index}
                      title={shape.name}
                      aria-label={shape.name}
                      onClick={() => look({ shape: index })}
                    >
                      <OrclingStill look={{ ...companion.look, shape: index }} size={50} />
                      <span>{shape.name}</span>
                    </button>
                  ))}
                </div>
              </div>
              <div className="orcling-profile-section">
                <h2>Color</h2>
                <div className="orcling-color-options" role="radiogroup" aria-label="Body color" onKeyDown={moveRadio}>
                  {ORCLING_BODY_COLORS.map((color) => (
                    <button
                      key={color.name}
                      role="radio"
                      tabIndex={companion.look.bodyColor === color.hex ? 0 : -1}
                      aria-label={color.name}
                      title={color.name}
                      aria-checked={companion.look.bodyColor === color.hex}
                      style={{ background: color.hex }}
                      onClick={() => look({ bodyColor: color.hex })}
                    >
                      {companion.look.bodyColor === color.hex ? <Check size={14} /> : null}
                    </button>
                  ))}
                </div>
              </div>
              <div className="orcling-look-fields">
                {(
                  [
                    ["eyes", "Eyes", ORCLING_EYES],
                    ["texture", "Texture", ORCLING_TEXTURES],
                    ["glasses", "Glasses", ORCLING_GLASSES],
                    ["accessory", "Accessory", ORCLING_ACCESSORIES],
                  ] as const
                ).map(([part, label, options]) => (
                  <label key={part}>
                    {label}
                    <select value={companion.look[part]} onChange={(event) => look({ [part]: Number(event.target.value) })}>
                      {options.map((option, index) => (
                        <option key={option.name} value={index}>
                          {option.name}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
              <p className="orcling-preview-feedback">Appearance changes live in this preview.</p>
            </>
          ) : null}
          {tab === "Instructions" ? (
            <div className="orcling-profile-section">
              <h2>How {companion.name} works with you</h2>
              <p>These instructions belong to this Orcling, wherever it works.</p>
              <textarea aria-label={`${companion.name}'s instructions`} rows={7} value={instructions} onChange={(event) => setInstructions(event.target.value)} />
              <div className="orcling-save-row">
                <Button
                  variant="primary"
                  disabled={instructions === companion.instructions}
                  onClick={() => {
                    onChange({ instructions });
                    setFeedback("Saved in this preview.");
                  }}
                >
                  Save instructions
                </Button>
                <span role="status">{feedback}</span>
              </div>
              <details className="orcling-instruction-history">
                <summary>Earlier versions</summary>
                <p>Version 1 · You · Today</p>
                <p>{originalInstructions}</p>
                <Button size="sm" variant="ghost" onClick={() => setInstructions(originalInstructions)}>
                  Use this version
                </Button>
              </details>
            </div>
          ) : null}
          {tab === "Memory" ? (
            <div className="orcling-profile-section">
              <h2>What {companion.name} remembers</h2>
              <p>Private to this Orcling, separate from project memory.</p>
              <div className="orcling-memory-row">
                <strong>Keep the first step clear</strong>
                <p>You prefer a focused welcome flow with one useful action at a time.</p>
                <span>Preference · Today</span>
              </div>
              <div className="orcling-memory-row">
                <strong>Show the work in context</strong>
                <p>Keep plans and review notes close to the conversation they belong to.</p>
                <span>Decision · Today</span>
              </div>
            </div>
          ) : null}
        </section>
      </div>
    </div>
  );
}
