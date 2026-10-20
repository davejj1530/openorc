import { useState } from "react";
import type { Project } from "@openorc/protocol";
import { Button, Field, Input, Textarea } from "../components/ui";
import { useRpc, useRpcMutation } from "../lib/query";

/** What the repository already says about itself: its default branch, remote and other tools' config files. */
function ProjectFacts({ project: p }: { project: Project }) {
  const facts = [
    { label: "Default branch", value: p.defaultBranch ?? "unknown" },
    ...(p.gitRemote ? [{ label: "Remote", value: p.gitRemote }] : []),
    ...(p.settings.detectedConfigs.length > 0 ? [{ label: "Found", value: p.settings.detectedConfigs.join(", ") }] : []),
  ];
  return (
    <dl className="mb-5 grid gap-1 text-sm">
      {facts.map((fact) => (
        <div key={fact.label} className="flex min-w-0 gap-3">
          <dt className="w-28 shrink-0 text-ink-4">{fact.label}</dt>
          <dd className="min-w-0 truncate font-mono text-ink-2">{fact.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Worktree settings for a project's tasks, in one card. Saving says so in place until the next edit. */
export function ProjectSettings({ projectId }: { projectId: string }) {
  const project = useRpc("projects.get", { id: projectId });
  const update = useRpcMutation("projects.updateSettings");
  const p = project.data;
  const [setupScript, setSetupScript] = useState<string | null>(null);
  const [include, setInclude] = useState<string | null>(null);
  const [prefix, setPrefix] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  if (!p) return null;
  const s = p.settings;
  const edit = (set: (value: string) => void) => (value: string) => {
    setSaved(false);
    set(value);
  };
  const save = () =>
    update.mutate(
      {
        id: p.id,
        settings: {
          branchPrefix: (prefix ?? s.branchPrefix).trim() || "openorc",
          worktreeInclude: (include ?? s.worktreeInclude.join("\n"))
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean),
          setupScript: (setupScript ?? s.setupScript ?? "").trim() || null,
        },
      },
      {
        onSuccess: () => {
          setPrefix(null);
          setInclude(null);
          setSetupScript(null);
          setSaved(true);
        },
      },
    );

  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <div className="w-full max-w-2xl px-6 pt-4 pb-10">
        <section data-plane aria-label="Project settings" className="rounded-3xl bg-surface p-5">
          <ProjectFacts project={p} />
          <Field label="Branch prefix" hint="Task branches are named prefix/slug-id.">
            <Input value={prefix ?? s.branchPrefix} onChange={(e) => edit(setPrefix)(e.target.value)} />
          </Field>
          <Field label="Copy these gitignored files into new worktrees" hint="One pattern per line, gitignore syntax. .env files by default.">
            <Textarea rows={3} className="font-mono" value={include ?? s.worktreeInclude.join("\n")} onChange={(e) => edit(setInclude)(e.target.value)} />
          </Field>
          <Field label="Setup script" hint="Runs in the new worktree before the agent starts. OPENORC_PORT, OPENORC_WORKSPACE_PATH, and OPENORC_ROOT_PATH are set.">
            <Textarea rows={4} className="font-mono" placeholder="pnpm install --frozen-lockfile" value={setupScript ?? s.setupScript ?? ""} onChange={(e) => edit(setSetupScript)(e.target.value)} />
          </Field>
          <div className="mt-5 flex items-center justify-end gap-3">
            <span role="status" className="text-sm text-ink-4">
              {saved ? <span className="motion-arrive inline-block">Saved</span> : null}
            </span>
            <Button variant="primary" size="lg" disabled={update.isPending} onClick={save}>
              Save settings
            </Button>
          </div>
          {update.error ? <p className="mt-2 text-sm text-bad">{update.error.message}</p> : null}
        </section>
      </div>
    </div>
  );
}
