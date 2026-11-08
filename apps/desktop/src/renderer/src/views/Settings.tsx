import { Menu } from "@base-ui/react/menu";
import { distillationHarnessIds, harnessCatalog, isHarnessId, type AppSettings, type ExtractionProviderChoice, type RpcResults } from "@openorc/protocol";
import type { UseQueryResult } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, RefreshCw } from "../components/icons";
import { MemoryControl } from "../components/MemoryControl";
import { menuItem, menuPopup } from "../components/menu";
import { TopBar } from "../components/TopBar";
import { Button, Input, Select } from "../components/ui";
import { CoversPreview } from "../lib/browser-preview";
import { useRpc } from "../lib/client";
import { cn } from "../lib/cn";
import { useLayout } from "../lib/layout";
import { useRouter, type Route, type SettingsSection } from "../lib/router";
import { settingsSection, settingsSections } from "../lib/settings-sections";
import { floatingGround } from "../lib/use-anchor-ground";
import { AgentConnections } from "./settings-agent-updates";
import { useEnabledHarnesses } from "../lib/enabled-harnesses";
import { AppearanceSettings } from "./settings-appearance";
import { ClaudeAccountSettings } from "./settings-claude-accounts";
import { ConnectorSettings } from "./settings-connectors";
import { CloudSettings } from "./settings-cloud";
import { DeviceSettings } from "./settings-devices";
import { GitHubSettings } from "./settings-github";
import { PairPhone, PhoneSettings } from "./settings-phone";
import { idleTimeoutLabel, learningStatus, memoryModelAgent } from "./settings-presentation";
import { Field, LoadError, SaveStatus, Section, SectionActionsSlot, Toggle, usePreference } from "./settings-shared";
import { SkillsSettings } from "./settings-skills";
import { SlackSettings } from "./settings-slack";
import { TextGenerationSettings } from "./settings-text-generation";
import { UpdateSettingsSection } from "./settings-updates";
import { ProviderUsageOverview } from "./settings-usage";

type SettingsRoute = Extract<Route, { view: "settings" }>;

/** The sidebar lists the sections, the route says which one is open, and the top bar names it. */
export function Settings({ route }: { route: SettingsRoute }) {
  const current = settingsSection(route);
  const content = useRef<HTMLDivElement>(null);
  // Each section opens at its top, unless the link that opened it points further down.
  useEffect(() => {
    if (content.current) content.current.scrollTop = 0;
    const frame = requestAnimationFrame(() => revealSetting(route));
    return () => cancelAnimationFrame(frame);
  }, [route]);
  const info = useRpc("system.info", { refresh: true });
  const [actionsSlot, setActionsSlot] = useState<HTMLElement | null>(null);
  return (
    <div className="settings-sheet">
      <TopBar
        actions={
          <>
            <PageActions id={current.id} info={info} />
            <span ref={setActionsSlot} className="flex items-center gap-1" />
          </>
        }
      >
        <SettingsTitle current={current} />
      </TopBar>
      <SectionActionsSlot.Provider value={actionsSlot}>
        <div className="settings-shell">
          <div ref={content} className="settings-content">
            {current.description ? <p className="settings-page-lead">{current.description}</p> : null}
            {settingsSections.map(({ id, label }) => (
              <section key={id} id={`settings-${id}`} aria-label={label} hidden={id !== current.id}>
                <SectionSettings id={id} active={id === current.id} info={info} />
              </section>
            ))}
          </div>
        </div>
      </SectionActionsSlot.Provider>
    </div>
  );
}

/** What the open section offers beside its title: checking the connections again, or pairing a phone. */
function PageActions({ id, info }: { id: SettingsSection; info: UseQueryResult<RpcResults["system.info"]> }) {
  if (id === "connections")
    return (
      <Button size="lg" disabled={info.isFetching} onClick={() => void info.refetch()}>
        <RefreshCw size={13} />
        {info.isFetching ? "Checking…" : "Refresh connections"}
      </Button>
    );
  return id === "phone" ? <PairPhone /> : null;
}

/** Brings what a link into Settings points at into view: a provider's usage. */
function revealSetting(route: SettingsRoute) {
  if (route.section !== "usage" || !route.provider) return;
  const target = document.querySelector<HTMLElement>(`[data-usage-provider="${route.provider}"]`);
  target?.scrollIntoView?.({ block: "start" });
  target?.focus({ preventScroll: true });
}

/** The open section's name, in the top bar. While the sidebar is hidden, it also switches sections. */
export function SettingsTitle({ current }: { current: { id: SettingsSection; label: string } }) {
  const sidebarOpen = useLayout((s) => s.sidebarOpen);
  const navigate = useRouter((s) => s.navigate);
  if (sidebarOpen) return <h1 className="settings-window-title">{current.label}</h1>;
  return (
    <h1 className="settings-window-title">
      <Menu.Root>
        <Menu.Trigger className="settings-section-menu no-drag">
          <span className="truncate">{current.label}</span>
          <ChevronDown size={14} className="shrink-0" />
        </Menu.Trigger>
        <Menu.Portal>
          <CoversPreview />
          <Menu.Positioner sideOffset={6} align="start" className="z-40" collisionPadding={8}>
            <Menu.Popup ref={floatingGround} className={menuPopup}>
              {settingsSections.map(({ id, label }) => (
                <Menu.Item key={id} className={menuItem} onClick={() => navigate({ view: "settings", section: id })}>
                  <Check size={13} className={cn("text-transparent", id === current.id && "text-ink")} />
                  <span className="truncate">{label}</span>
                </Menu.Item>
              ))}
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
    </h1>
  );
}

/** One section's settings. Every section stays mounted, so a change in progress survives a look at another. */
function SectionSettings({ id, active, info }: { id: SettingsSection; active: boolean; info: UseQueryResult<RpcResults["system.info"]> }) {
  const enabled = useEnabledHarnesses();
  switch (id) {
    case "usage":
      return <ProviderUsageOverview active={active} />;
    case "connections":
      return (
        <>
          {info.isError && <LoadError retry={() => void info.refetch()} />}
          <AgentConnections info={info.data} />
          {enabled.includes("claude") ? <ClaudeAccountSettings active={active} /> : null}
          <GitHubSettings info={info.data} />
        </>
      );
    case "cloud":
      return <CloudSettings active={active} />;
    case "slack":
      return <SlackSettings active={active} />;
    case "phone":
      return <PhoneSettings active={active} />;
    case "skills":
      return <SkillsSettings active={active} />;
    case "connectors":
      return <ConnectorSettings active={active} />;
    case "devices":
      return <DeviceSettings active={active} />;
    case "appearance":
      return <AppearanceSettings />;
    case "general":
      return <GeneralSettings />;
    case "memory":
      return (
        <>
          <MemorySettings />
          <TextGenerationSettings />
        </>
      );
    case "data":
      return <DataSettings dataDir={info.data?.dataDir} error={info.isError} retry={() => void info.refetch()} />;
  }
}

const days = (v: number | null | undefined) => (v == null ? "" : String(v));
const idleOptions = [null, 5, 10, 30, 60];

function GeneralSettings() {
  const s = usePreference("app.settings.set");
  const v = s.value;
  return (
    <>
      {s.query.isError && <LoadError retry={() => void s.query.refetch()} />}
      <Section title="Notifications">
        <Toggle
          label="Desktop notifications"
          hint="When a thread finishes, asks a question, or fails while you are elsewhere."
          checked={v.notifications ?? true}
          disabled={s.disabled}
          onChange={(notifications) => void s.commit({ notifications })}
        />
        <Toggle
          label="Notification sound"
          hint="Play a sound with desktop notifications."
          checked={v.sound ?? false}
          disabled={s.disabled || v.notifications === false}
          onChange={(sound) => void s.commit({ sound })}
        />
      </Section>
      <UpdateSettingsSection />
      <Section title="Workspace" description="Used for new threads. Tasks created in a conversation use that thread’s workspace.">
        <Field label="New thread workspace">
          <Select value={v.defaultWorkspaceMode ?? "current"} disabled={s.disabled} onChange={(e) => void s.commit({ defaultWorkspaceMode: e.target.value as AppSettings["defaultWorkspaceMode"] })}>
            <option value="current">Local checkout</option>
            <option value="worktree">Isolated worktree</option>
          </Select>
        </Field>
      </Section>
      <Section title="Agents" description="Keep agents ready for quick replies, or free memory by closing idle agents. Sessions resume with your next message.">
        <Field label="Close idle processes after">
          <Select value={days(v.idleProcessMinutes)} disabled={s.disabled} onChange={(e) => void s.commit({ idleProcessMinutes: e.target.value ? Number(e.target.value) : null })}>
            {idleOptions.map((m) => (
              <option key={days(m)} value={days(m)}>
                {idleTimeoutLabel(m)}
              </option>
            ))}
          </Select>
        </Field>
      </Section>
      <SaveStatus status={s.status} retry={() => void s.retry()} />
    </>
  );
}

/** The choices offered for distillation: automatic, each harness that can distil, the API key, or off. */
const providerChoices: readonly ExtractionProviderChoice[] = ["auto", ...distillationHarnessIds, "apikey", "off"];
const providerLabel = (choice: ExtractionProviderChoice): string => {
  if (choice === "auto") return "Automatic · per agent";
  if (choice === "apikey") return "Anthropic API key";
  if (choice === "off") return "Off · no background learning";
  return `${harnessCatalog[choice].name} subscription`;
};
function MemoryProviderOptions() {
  const enabled = useEnabledHarnesses();
  return (
    <>
      {providerChoices
        .filter((provider) => !isHarnessId(provider) || enabled.includes(provider))
        .map((provider) => (
          <option key={provider} value={provider}>
            {providerLabel(provider)}
          </option>
        ))}
    </>
  );
}

export function MemorySettings() {
  const s = usePreference("memory.settings.set");
  const v = s.value;
  const [apiKey, setApiKey] = useState("");
  const saved = s.query.data && "automatic" in s.query.data ? s.query.data : null;
  const memoryEnabled = saved?.enabled;
  const provider = v.provider ?? "auto";
  const resolved = v.resolved;
  const storageError = v.apiKeyError ?? (s.status === "error" ? s.error?.message : null);
  // An Anthropic API key runs through Claude Code, so its model list is Claude's. Automatic uses each agent's default.
  const modelAgent = memoryModelAgent(provider);
  const models = useRpc("agents.models", { agent: modelAgent ?? "claude" }, { enabled: Boolean(modelAgent) && Boolean(memoryEnabled) });
  const options = models.data ?? [];
  return (
    <>
      {s.query.isError && <LoadError retry={() => void s.query.refetch()} />}
      <MemoryControl />
      <Section
        title="Learn from completed runs"
        description="An optional background model extracts useful lessons after each run. When this is off, agents can still save memories if OpenOrc memory is on."
      >
        <Field label="Provider" hint="Automatic summarizes each run with the agent that ran it. A chosen provider summarizes every run, whichever agent did the work.">
          <Select
            value={provider}
            disabled={s.disabled || !memoryEnabled}
            onChange={(e) => {
              setApiKey("");
              void s.commit({ provider: e.target.value as ExtractionProviderChoice });
            }}
          >
            <MemoryProviderOptions />
          </Select>
        </Field>
        {provider === "apikey" && (
          <div className="py-3">
            <Field
              label="Anthropic API key"
              hint={v.hasApiKey ? "A key is saved in protected OS storage. Enter a replacement to update it." : "Stored with OS protection. Billed separately from a Claude subscription."}
            >
              <Input type="password" autoComplete="off" value={apiKey} disabled={s.disabled} placeholder="Enter API key" onChange={(e) => setApiKey(e.target.value)} />
            </Field>
            <div className="flex justify-end gap-2">
              {(v.hasApiKey || v.apiKeyError) && (
                <Button
                  disabled={s.disabled}
                  onClick={() => {
                    setApiKey("");
                    void s.commit({ apiKey: "" });
                  }}
                >
                  Remove API key
                </Button>
              )}
              <Button
                disabled={s.disabled || !apiKey.trim()}
                onClick={() => {
                  const key = apiKey.trim();
                  setApiKey("");
                  void s.commit({ apiKey: key });
                }}
              >
                Save API key
              </Button>
            </div>
          </div>
        )}
        {modelAgent && (
          <Field label="Model">
            <Select value={v.model ?? ""} disabled={s.disabled || !memoryEnabled || options.length === 0} onChange={(e) => void s.commit({ model: e.target.value || null })}>
              <option value="">{resolved && !v.model ? `Default (${resolved.label})` : "Default"}</option>
              {v.model && !options.some((m) => m.id === v.model) && <option value={v.model}>{v.model}</option>}
              {options.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {modelAgent && models.isError && <LoadError retry={() => void models.refetch()} />}
        {storageError && (
          <p role="alert" className="text-ink-2 mt-3">
            {storageError}{" "}
            <Button size="sm" disabled={s.query.isFetching} onClick={() => void s.query.refetch()}>
              Retry storage
            </Button>
          </p>
        )}
        <p className="text-ink-2 mt-3">{learningStatus({ loading: s.query.isLoading, error: s.query.isError, saved, provider, storageError, reason: v.reason })}</p>
      </Section>
      <SaveStatus status={s.status} retry={() => void s.retry()} />
    </>
  );
}

function DataSettings({ dataDir, error, retry }: { dataDir?: string; error: boolean; retry: () => void }) {
  return (
    <>
      <Section title="Local storage" description="Your ledger, memories, and worktrees live in the OpenOrc data folder.">
        <span className="settings-storage-label">Data folder</span>
        {error ? <LoadError retry={retry} /> : <code className="settings-path">{dataDir ?? "Loading data location…"}</code>}
      </Section>
      <Section title="How your data is used">
        <div className="settings-data-note">
          <h3>Memory search</h3>
          <p>Search runs on this device.</p>
        </div>
        <div className="settings-data-note">
          <h3>Agent requests</h3>
          <p>Each agent’s requests go to its own provider.</p>
        </div>
        <div className="settings-data-note">
          <h3>Background models</h3>
          <p>Run summaries, while memory is on, and conversation titles use that same agent unless you choose another provider in Memory &amp; models.</p>
        </div>
      </Section>
    </>
  );
}
