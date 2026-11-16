import { useState } from "react";
import { HOSTED_AGENTS, harnessCatalog, type CloudSkill, type HostedAgent } from "@openorc/protocol";
import { Dialog, Input, Switch, TextButton } from "../components/ui";
import { queryClient, useRpc, useRpcMutation } from "../lib/client";
import { useEnabledHarnesses } from "../lib/enabled-harnesses";
import { formatBytes } from "../lib/file-imports";
import { Failure } from "./settings-secret-field";
import { Section, SettingRow } from "./settings-shared";

type Choose = ReturnType<typeof useRpcMutation<"hostedSkills.choose">>;

/** The list a choice answers with, shown at once. */
const shown = (agent: HostedAgent) => (list: CloudSkill[]) => queryClient.setQueryData(["hostedSkills.list", { agent }], list);

const sendable = (skills: CloudSkill[]) => skills.filter((skill) => skill.cause === null);

/** What goes, said in a few words: all, none, or how many of how many. */
function goingHint(skills: CloudSkill[]): string {
  if (!skills.length) return "No skills";
  const going = sendable(skills).filter((skill) => skill.on).length;
  if (going === skills.length) return skills.length === 1 ? "It goes to the cloud" : `All ${skills.length} go to the cloud`;
  if (!going) return "None go to the cloud";
  return `${going} of ${skills.length} go to the cloud`;
}

const sentence = (cause: string) => cause.charAt(0).toUpperCase() + cause.slice(1);

function SkillRow({ skill, agent, choose }: { skill: CloudSkill; agent: HostedAgent; choose: Choose }) {
  const pending = choose.isPending && choose.variables?.names.includes(skill.name) ? choose.variables.on : null;
  const held = skill.cause !== null;
  return (
    <SettingRow label={skill.name} hint={skill.description ? <span className="line-clamp-2">{skill.description}</span> : undefined}>
      <span className="text-ink-3 tabular-nums">{held ? "Can't be read" : formatBytes(skill.bytes ?? 0)}</span>
      {/* The switch's knob covers its input, so a held one carries its reason around it. */}
      <span data-tip={held ? sentence(skill.cause!) : undefined}>
        <Switch
          aria-label={`${skill.name} in cloud threads`}
          checked={held ? false : (pending ?? skill.on)}
          disabled={held || choose.isPending}
          onChange={(event) => choose.mutate({ agent, names: [skill.name], on: event.target.checked }, { onSuccess: shown(agent) })}
        />
      </span>
    </SettingRow>
  );
}

/** One agent's skills as switches, a search over their names and words, and every listed one on or off at once. */
function SkillSwitches({ agent, skills, choose }: { agent: HostedAgent; skills: CloudSkill[]; choose: Choose }) {
  const [search, setSearch] = useState("");
  const needle = search.trim().toLowerCase();
  const listed = [...skills].sort((a, b) => a.name.localeCompare(b.name)).filter((skill) => !needle || `${skill.name} ${skill.description}`.toLowerCase().includes(needle));
  const names = sendable(listed).map((skill) => skill.name);
  const all = (on: boolean) => choose.mutate({ agent, names, on }, { onSuccess: shown(agent) });
  return (
    <div className="space-y-3">
      <div className="sticky top-0 z-10 -mt-3 flex items-center gap-3 bg-surface pt-3 pb-3">
        <Input aria-label="Search skills" placeholder="Search" value={search} onChange={(event) => setSearch(event.target.value)} />
        <TextButton tone="muted" className="shrink-0" disabled={!names.length || choose.isPending} onClick={() => all(true)}>
          All on
        </TextButton>
        <TextButton tone="muted" className="shrink-0" disabled={!names.length || choose.isPending} onClick={() => all(false)}>
          All off
        </TextButton>
      </div>
      <div className="settings-group">
        {listed.map((skill) => (
          <SkillRow key={skill.name} skill={skill} agent={agent} choose={choose} />
        ))}
        {listed.length ? null : <p className="text-ink-3 py-3">No skill matches.</p>}
      </div>
      <Failure error={choose.error} />
    </div>
  );
}

/** An agent's own skills in a row naming how many go; its switches open in a sheet, as an agent may have dozens. */
function AgentSkills({ agent, active }: { agent: HostedAgent; active: boolean }) {
  const [open, setOpen] = useState(false);
  const skills = useRpc("hostedSkills.list", { agent }, { enabled: active });
  const choose = useRpcMutation("hostedSkills.choose");
  const name = harnessCatalog[agent].name;
  if (skills.error)
    return (
      <SettingRow label={name} hint={<span className="text-bad">{skills.error.message}</span>}>
        {null}
      </SettingRow>
    );
  const list = skills.data ?? [];
  return (
    <SettingRow label={name} hint={skills.data ? goingHint(list) : undefined}>
      {list.length ? (
        <TextButton tone="muted" onClick={() => setOpen(true)}>
          Choose
        </TextButton>
      ) : null}
      <Dialog open={open} onOpenChange={setOpen} title={`${name} skills in the cloud`} width={640}>
        <SkillSwitches agent={agent} skills={list} choose={choose} />
      </Dialog>
    </SettingRow>
  );
}

/** The person's own skills, each agent's, and which of them go to their cloud threads; on this Mac they stay as they are. */
export function CloudSkillsSection({ active }: { active: boolean }) {
  const enabled = useEnabledHarnesses();
  const agents = HOSTED_AGENTS.filter((agent) => enabled.includes(agent));
  if (!agents.length) return null;
  return (
    <Section title="Skills">
      {agents.map((agent) => (
        <AgentSkills key={agent} agent={agent} active={active} />
      ))}
    </Section>
  );
}
