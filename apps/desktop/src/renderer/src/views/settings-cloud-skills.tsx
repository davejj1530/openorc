import { useState } from "react";
import { harnessCatalog, type CloudSkills } from "@openorc/protocol";
import { Dialog, Input, Switch, TextButton } from "../components/ui";
import { queryClient, useRpc, useRpcMutation } from "../lib/client";
import { useEnabledHarnesses } from "../lib/enabled-harnesses";
import { Failure } from "./settings-secret-field";
import { Section, SettingRow } from "./settings-shared";

const shown = (skills: CloudSkills) => queryClient.setQueryData(["cloud.skills", {}], skills);

type Agent = CloudSkills["agents"][number];
type Choose = ReturnType<typeof useRpcMutation<"cloud.skills.choose">>;

/** A long list gets a filter; a short one is read at a glance. */
const FILTER_FROM = 10;

function chosenHint({ skills }: Agent): string {
  const chosen = skills.filter((skill) => skill.chosen);
  if (!chosen.length) return "None chosen";
  return chosen.length <= 2 ? chosen.map((skill) => skill.name).join(" and ") : `${chosen.length} of ${skills.length} chosen`;
}

function SkillSwitches({ agent, choose }: { agent: Agent; choose: Choose }) {
  const [filter, setFilter] = useState("");
  const pending = choose.isPending && choose.variables?.agent === agent.agent ? choose.variables : null;
  const needle = filter.trim().toLowerCase();
  const listed = needle ? agent.skills.filter((skill) => `${skill.name} ${skill.description}`.toLowerCase().includes(needle)) : agent.skills;
  return (
    <div className="space-y-3">
      {agent.skills.length >= FILTER_FROM ? <Input aria-label="Filter skills" placeholder="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} /> : null}
      <div className="settings-group max-h-[50vh] overflow-y-auto">
        {listed.map((skill) => (
          <SettingRow key={skill.name} label={skill.name} hint={skill.description ? <span className="line-clamp-2">{skill.description}</span> : undefined}>
            <Switch
              aria-label={`${skill.name} in cloud threads`}
              checked={pending?.name === skill.name ? pending.on : skill.chosen}
              disabled={pending !== null}
              onChange={(e) => choose.mutate({ agent: agent.agent, name: skill.name, on: e.target.checked }, { onSuccess: shown })}
            />
          </SettingRow>
        ))}
        {listed.length ? null : <p className="text-ink-3 p-3">No skill matches.</p>}
      </div>
      <Failure error={choose.error} />
    </div>
  );
}

/** An agent's own skills in a row, which ones go named; its switches open in a sheet, as an agent may have dozens. */
function AgentSkills({ agent, choose }: { agent: Agent; choose: Choose }) {
  const [open, setOpen] = useState(false);
  const name = harnessCatalog[agent.agent].name;
  if (agent.error)
    return (
      <SettingRow label={name} hint={<span className="text-bad">{agent.error}</span>}>
        {null}
      </SettingRow>
    );
  return (
    <SettingRow label={name} hint={chosenHint(agent)}>
      <TextButton tone="muted" onClick={() => setOpen(true)}>
        Choose
      </TextButton>
      <Dialog open={open} onOpenChange={setOpen} title={`${name} skills in the cloud`} width={560}>
        <SkillSwitches agent={agent} choose={choose} />
      </Dialog>
    </SettingRow>
  );
}

/** The user's own skills, each agent's, chosen to go to cloud threads too. Shown once an agent has any. */
export function CloudSkillsSection({ active }: { active: boolean }) {
  const enabled = useEnabledHarnesses();
  const skills = useRpc("cloud.skills", {}, { enabled: active });
  const choose = useRpcMutation("cloud.skills.choose");
  const agents = (skills.data?.agents ?? []).filter((agent) => enabled.includes(agent.agent) && (agent.skills.length || agent.error));
  if (skills.error) return <Failure error={skills.error} />;
  if (!agents.length) return null;
  return (
    <Section title="Skills" description="Cloud threads get the ones you choose. A project's own skills go with its files.">
      {agents.map((agent) => (
        <AgentSkills key={agent.agent} agent={agent} choose={choose} />
      ))}
    </Section>
  );
}
