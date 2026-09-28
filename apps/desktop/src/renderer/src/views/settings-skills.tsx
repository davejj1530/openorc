import { projectSkillsPlaceholder, skillsStatus } from "./settings-presentation";
import { useEffect, useState } from "react";
import type { AgentSkill, HarnessId, Project } from "@openorc/protocol";
import { ChevronDown, RefreshCw, Search } from "../components/icons";
import { Button, Input, Select } from "../components/ui";
import { cn } from "../lib/cn";
import { useLayout } from "../lib/layout";
import { useRpc } from "../lib/query";
import { LoadError } from "./settings-shared";

const harnesses = [
  { id: "codex", label: "Codex", usage: "Type $name in a Codex message to invoke a skill." },
  { id: "claude", label: "Claude Code", usage: "Type /name in a Claude Code message to invoke a skill." },
  { id: "opencode", label: "OpenCode", usage: "OpenCode loads skills through its skill tool. Ask it to use a skill by name." },
] satisfies { id: HarnessId; label: string; usage: string }[];
const invocation: Record<HarnessId, string> = { codex: "$", claude: "/", opencode: "" };

const sources = [
  { id: "project", title: "Project skills", description: "Found in this project’s skill folders." },
  { id: "user", title: "Your skills", description: "Available across projects from your home folder." },
  { id: "plugin", title: "Plugin skills", description: "Provided by installed plugins." },
  { id: "system", title: "Built-in skills", description: "Provided by the harness." },
] satisfies { id: AgentSkill["source"]; title: string; description: string }[];

// Skill frontmatter sometimes uses inline Markdown; the catalog is plain text.
const readableDescription = (description: string) =>
  description
    .replace(/\*\*|`/g, "")
    .replace(/\s+/g, " ")
    .trim();

function SkillsScope({ projects, projectId, error, onProject }: { projects: Project[] | undefined; projectId: string; error: boolean; onProject: (id: string) => void }) {
  const placeholder = projectSkillsPlaceholder(error, Boolean(projects));
  return (
    <div className="skills-scope">
      <div>
        <label htmlFor="skills-project" className="font-medium">
          Project
        </label>
        <p className="text-sm text-ink-2 mt-1">Project skills vary by project. Each agent also has its own personal and plugin skills.</p>
      </div>
      <Select id="skills-project" value={projectId} disabled={!projects?.length} onChange={(event) => onProject(event.target.value)}>
        {!projects?.some((project) => project.id === projectId) && <option value={projectId}>{placeholder}</option>}
        {projects?.map((project) => (
          <option key={project.id} value={project.id}>
            {project.name}
          </option>
        ))}
      </Select>
    </div>
  );
}

function harnessBadge(catalog: { isError: boolean; isSuccess: boolean; data?: AgentSkill[] }): { text: string; label: string } {
  if (catalog.isError) return { text: "!", label: "Could not load skills" };
  if (catalog.isSuccess) return { text: String(catalog.data?.length ?? 0), label: `${catalog.data?.length ?? 0} skills` };
  return { text: "…", label: "Loading skills" };
}

function HarnessPicker({ agent, onAgent, badges }: { agent: HarnessId; onAgent: (agent: HarnessId) => void; badges: Record<HarnessId, { text: string; label: string }> }) {
  return (
    <div className="skills-harnesses" role="group" aria-label="Skill harness">
      {harnesses.map((harness) => (
        <button key={harness.id} type="button" className="skills-harness" aria-pressed={agent === harness.id} onClick={() => onAgent(harness.id)}>
          <span>{harness.label}</span>
          <span className="skills-harness-count" aria-label={badges[harness.id].label}>
            {badges[harness.id].text}
          </span>
        </button>
      ))}
    </div>
  );
}

function SkillsToolbar({ search, onSearch, refreshing, onRefresh }: { search: string; onSearch: (value: string) => void; refreshing: boolean; onRefresh: () => void }) {
  return (
    <div className="skills-toolbar">
      <div className="skills-search">
        <Search size={15} aria-hidden="true" />
        <Input type="search" aria-label="Search skills" placeholder="Search skills" className="h-7" value={search} onChange={(event) => onSearch(event.target.value)} />
      </div>
      <Button disabled={refreshing} onClick={onRefresh}>
        <RefreshCw size={13} />
        {refreshing ? "Checking…" : "Refresh skills"}
      </Button>
    </div>
  );
}

function SkillGroup({ group, agent }: { group: (typeof sources)[number] & { items: AgentSkill[] }; agent: HarnessId }) {
  return (
    <section className="settings-section skills-section">
      <div className="skills-section-heading">
        <h2 className="text-lg font-semibold">{group.title}</h2>
        <span className="text-sm text-ink-3 tabular-nums" aria-label={`${group.items.length} skills`}>
          {group.items.length}
        </span>
      </div>
      <p className="text-ink-2 mt-1">{group.description}</p>
      <ul className="settings-group skills-list">
        {group.items.map((skill) => {
          const description = readableDescription(skill.description);
          return (
            <li key={skill.path}>
              <details className="skills-item">
                <summary className="skills-item-summary">
                  <span className="skills-command">
                    {invocation[agent]}
                    {skill.name}
                  </span>
                  <span className={cn("skills-preview", description ? "text-ink-2" : "text-ink-3")}>{description || "No description"}</span>
                  <ChevronDown size={14} className="skills-item-chevron" aria-hidden="true" />
                </summary>
                <div className="skills-item-detail">
                  <span className="text-ink-3">Location</span>
                  <code>{skill.path}</code>
                </div>
              </details>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function SkillsEmpty({ term, clear }: { term: string; clear: () => void }) {
  return (
    <div className="skills-empty">
      <p className="font-medium">{term ? "No matching skills" : "No skills found"}</p>
      <p className="text-sm text-ink-2 mt-1">{term ? "Try another name or description." : "A skill is a Markdown file in a project or personal skill folder. Plugins can add their own."}</p>
      {term && (
        <Button variant="ghost" className="mt-3" onClick={clear}>
          Clear search
        </Button>
      )}
    </div>
  );
}

/** Catalog the skills each supported harness can use in the selected project. */
export function SkillsSettings({ active }: { active: boolean }) {
  const projects = useRpc("projects.list", {});
  // Settings is a global surface and the rail can be on every project at once,
  // so the rail seeds this choice rather than being it. Only the project tier
  // depends on which project it is, and picking it here says which one that was.
  const railProject = useLayout((s) => s.projectId);
  const [projectId, setProjectId] = useState(railProject ?? "");
  const [agent, setAgent] = useState<HarnessId>("codex");
  const [search, setSearch] = useState("");
  useEffect(() => {
    const first = projects.data?.[0];
    if (!projectId && first) setProjectId(first.id);
  }, [projects.data, projectId]);
  // All three catalogs load together so the counts remain visible when switching harnesses.
  // Settings keeps its other panels mounted, so discovery only runs while this panel is active.
  const enabled = active && Boolean(projectId);
  const codex = useRpc("skills.list", { projectId, agent: "codex" }, { enabled, staleTime: 60_000 });
  const claude = useRpc("skills.list", { projectId, agent: "claude" }, { enabled, staleTime: 60_000 });
  const opencode = useRpc("skills.list", { projectId, agent: "opencode" }, { enabled, staleTime: 60_000 });
  const catalogs = { codex, claude, opencode };
  const skills = catalogs[agent];
  const found = skills.data ?? [];
  const term = search.trim().toLocaleLowerCase();
  const matching = term ? found.filter((skill) => `${skill.name} ${skill.description} ${skill.path}`.toLocaleLowerCase().includes(term)) : found;
  const groups = sources.map((source) => ({ ...source, items: matching.filter((skill) => skill.source === source.id) })).filter((group) => group.items.length > 0);
  const count = found.length === 1 ? "1 skill" : `${found.length} skills`;
  const refreshing = codex.isFetching || claude.isFetching || opencode.isFetching;
  const badges = { codex: harnessBadge(codex), claude: harnessBadge(claude), opencode: harnessBadge(opencode) };
  const onProject = (id: string) => {
    setProjectId(id);
    setSearch("");
  };
  const refreshAll = () => {
    void Promise.all([codex.refetch(), claude.refetch(), opencode.refetch()]);
  };
  return (
    <>
      <SkillsScope projects={projects.data} projectId={projectId} error={projects.isError} onProject={onProject} />
      {projects.isError && <LoadError retry={() => void projects.refetch()} />}
      {projects.isSuccess && projectId === "" && <p className="skills-empty">Import a project and OpenOrc will list the skills it can resolve there.</p>}
      {projectId !== "" && (
        <>
          <HarnessPicker agent={agent} onAgent={setAgent} badges={badges} />
          <p className="skills-usage text-sm text-ink-2">{harnesses.find((harness) => harness.id === agent)?.usage}</p>
          <SkillsToolbar search={search} onSearch={setSearch} refreshing={refreshing} onRefresh={refreshAll} />
          <p className="skills-status text-ink-2" role="status">
            {skills.isSuccess && term ? `${matching.length} of ${count}` : skillsStatus({ loading: skills.isLoading, error: skills.isError, found: found.length, success: skills.isSuccess, count })}
          </p>
          {skills.isError && <LoadError retry={() => void skills.refetch()} />}
          {groups.map((group) => (
            <SkillGroup key={group.id} group={group} agent={agent} />
          ))}
          {skills.isSuccess && matching.length === 0 && <SkillsEmpty term={term} clear={() => setSearch("")} />}
        </>
      )}
    </>
  );
}
