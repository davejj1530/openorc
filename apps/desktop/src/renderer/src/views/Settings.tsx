import { settingsTabIndex, idleTimeoutLabel, memoryModelAgent, learningStatus } from "./settings-presentation";
import { AgentConnections } from "./settings-agent-updates";
import { useRouter } from "../lib/router";
import { useEffect, useRef, useState } from "react";
import { RefreshCw } from "../components/icons";
import { distillationHarnessIds, harnessCatalog, type AppSettings, type ExtractionProviderChoice } from "@openorc/protocol";
import { TopBar } from "../components/TopBar";
import { MemoryControl } from "../components/MemoryControl";
import { Button, Input, Select } from "../components/ui";
import { useRpc } from "../lib/query";
import { AppearanceSettings } from "./settings-appearance";
import { GitHubSettings } from "./settings-github";
import { Field, LoadError, SaveStatus, Section, Toggle, usePreference } from "./settings-shared";
import { SkillsSettings } from "./settings-skills";
import { SlackSettings } from "./settings-slack";
import { ProviderUsageOverview } from "./settings-usage";
import { TextGenerationSettings } from "./settings-text-generation";
import { UpdateSettingsSection } from "./settings-updates";

const sections = [
  { id: "usage", label: "Usage", title: "Usage & allowances", description: "Your providers, their limits, and what’s left." },
  { id: "connections", label: "Connections", title: "Connections", description: "Manage the tools OpenOrc uses on your behalf." },
  { id: "slack", label: "Slack", title: "Slack", description: "Run Slack requests on your own computer." },
  { id: "skills", label: "Skills", title: "Skills", description: "Skills available to Codex, Claude Code, and OpenCode in this project." },
  { id: "appearance", label: "Appearance", title: "Appearance", description: "Make your workspace feel like yours." },
  { id: "general", label: "General", title: "General", description: "Make OpenOrc fit the way you work." },
  { id: "memory", label: "Memory & models", title: "Memory & models", description: "Control shared project memory and the models used for background work." },
  { id: "data", label: "Data", title: "Data on this device", description: "Know where your work lives and how it is used." },
] as const;

export function Settings() {
  const route = useRouter((state) => state.route);
  const [active, setActive] = useState<string>("usage");
  useEffect(() => {
    if (route.view !== "settings" || !route.section) return;
    setActive(route.section);
    const frame = requestAnimationFrame(() => {
      if (route.section === "general") {
        document.getElementById("team-execution-setting")?.scrollIntoView?.({ block: "center" });
        return;
      }
      if (route.section !== "usage" || !route.provider) return;
      const target = document.getElementById(`provider-usage-${route.provider}`);
      target?.scrollIntoView?.({ block: "start" });
      target?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [route]);
  const content = useRef<HTMLDivElement>(null);
  const select = (id: string) => {
    setActive(id);
    if (content.current) content.current.scrollTop = 0;
  };
  const info = useRpc("system.info", { refresh: true });
  return (
    <>
      <TopBar>Settings</TopBar>
      <div className="settings-shell">
        <div className="settings-layout">
          <nav className="settings-nav" aria-label="Settings sections">
            <div
              className="settings-tablist"
              role="tablist"
              aria-label="Settings sections"
              onKeyDown={(event) => {
                const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
                const index = tabs.indexOf(event.target as HTMLButtonElement);
                if (index < 0) return;
                const next = settingsTabIndex(event.key, index, tabs.length);
                if (next === null) return;
                event.preventDefault();
                tabs[next]?.focus();
                tabs[next]?.click();
              }}
            >
              {sections.map(({ id, label }) => (
                <button key={id} id={`settings-tab-${id}`} role="tab" aria-selected={active === id} tabIndex={active === id ? 0 : -1} aria-controls={`settings-${id}`} onClick={() => select(id)}>
                  {label}
                </button>
              ))}
            </div>
          </nav>
          <div ref={content} className="settings-content">
            {sections.map(({ id, title, description }) => (
              <div key={id} id={`settings-${id}`} role="tabpanel" aria-labelledby={`settings-tab-${id}`} tabIndex={0} hidden={active !== id}>
                <header className="settings-heading">
                  <h1 className="text-xl font-semibold">{title}</h1>
                  <p className="text-md text-ink-2 mt-1">{description}</p>
                </header>
                {id === "usage" && <ProviderUsageOverview active={active === id} />}
                {id === "connections" && (
                  <>
                    <div className="flex justify-end">
                      <Button disabled={info.isFetching} onClick={() => void info.refetch()}>
                        <RefreshCw size={13} />
                        {info.isFetching ? "Checking…" : "Refresh connections"}
                      </Button>
                    </div>
                    {info.isError && <LoadError retry={() => void info.refetch()} />}
                    <AgentConnections info={info.data} />
                    <GitHubSettings info={info.data} />
                  </>
                )}
                {id === "skills" && <SkillsSettings active={active === id} />}
                {id === "slack" && <SlackSettings active={active === id} />}
                {id === "appearance" && <AppearanceSettings />}
                {id === "general" && <GeneralSettings />}
                {id === "memory" && (
                  <>
                    <MemorySettings />
                    <TextGenerationSettings />
                  </>
                )}
                {id === "data" && (
                  <Section title="Local storage" description="Your ledger, memories, and worktrees live in the OpenOrc data folder.">
                    {info.isError ? <LoadError retry={() => void info.refetch()} /> : <code className="settings-path">{info.data?.dataDir ?? "Loading data location…"}</code>}
                    <p className="text-ink-2 mt-4">
                      Memory search runs on this device. Each agent’s requests go to its own provider. Run summaries, while memory is on, and conversation titles use that same agent unless you choose
                      another provider in Memory &amp; models.
                    </p>
                  </Section>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
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
      <Section
        title="Agents"
        description="A thread keeps its provider process open between turns so replies start at once. Closing quiet processes frees memory; the next message resumes the same session."
      >
        <Field label="Close idle processes after">
          <Select value={days(v.idleProcessMinutes)} disabled={s.disabled} onChange={(e) => void s.commit({ idleProcessMinutes: e.target.value ? Number(e.target.value) : null })}>
            {idleOptions.map((m) => (
              <option key={days(m)} value={days(m)}>
                {idleTimeoutLabel(m)}
              </option>
            ))}
          </Select>
        </Field>
        <Toggle
          label="Your Claude Code MCP servers"
          hint="Connect the MCP servers from your own Claude Code configuration in every thread. They finish connecting after Claude starts, so a slow one can miss the first message; OpenOrc's own tools always load."
          checked={v.claudeUserMcpServers ?? true}
          disabled={s.disabled}
          onChange={(claudeUserMcpServers) => void s.commit({ claudeUserMcpServers })}
        />
      </Section>
      <Section id="team-execution-setting" title="Orchestration">
        <Toggle
          label="Team execution (Beta)"
          hint="Run saved teams through three levels: lead, managers and workers. Teams support schedules, forks and workspace moves. Failed workspace operations keep recovery options and saved files. Turning this off keeps existing activity and Stop available."
          checked={v.experimentalTeamExecution ?? true}
          disabled={s.disabled}
          onChange={(experimentalTeamExecution) => void s.commit({ experimentalTeamExecution })}
        />
      </Section>
      <SaveStatus status={s.status} retry={() => void s.retry()} />
    </>
  );
}

/** The choices offered for distillation: automatic, each harness that can distil, the API key, or off. */
const providerChoices: readonly ExtractionProviderChoice[] = ["auto", ...distillationHarnessIds, "apikey", "off"];
const providerLabel = (choice: ExtractionProviderChoice): string => {
  if (choice === "auto") return "Automatic · the agent that ran it";
  if (choice === "apikey") return "Anthropic API key";
  if (choice === "off") return "Off · no background learning";
  return `${harnessCatalog[choice].name} subscription`;
};
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
      <div className="mb-6">
        <MemoryControl />
      </div>
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
            {providerChoices.map((p) => (
              <option key={p} value={p}>
                {providerLabel(p)}
              </option>
            ))}
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
