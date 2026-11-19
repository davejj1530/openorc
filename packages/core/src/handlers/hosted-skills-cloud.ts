import type { HostedSkillSends } from "@openorc/hosted";
import { isHostedAgent, type HarnessId, type HostedSkillsCloudRpcResults } from "@openorc/protocol";
import type { AppSettingsService } from "../services/settings.js";
import type { HostedSkills } from "../services/hosted-skills.js";
import type { Handlers } from "./types.js";

/**
 * An agent's skills for the cloud and the person's choice of which go, kept on this Mac (`cloudSkillsOff`), a change
 * of which sends the sets again; the skills its last cloud set left out, with why: none before a cloud send; and how
 * many are going up now. Without OpenOrc Cloud there are none.
 */
export function createHostedSkillsCloudHandlers(
  skills: () => HostedSkills | null,
  settings: AppSettingsService,
  sends: () => HostedSkillSends | null,
): Pick<Handlers, keyof HostedSkillsCloudRpcResults> {
  const choose = (agent: HarnessId, names: readonly string[], on: boolean) => {
    const all = settings.get().cloudSkillsOff;
    const others = (all[agent] ?? []).filter((name) => !names.includes(name));
    settings.set({ cloudSkillsOff: { ...all, [agent]: on ? others : [...others, ...names] } });
    sends()?.changed();
  };
  return {
    "hostedSkills.leftOut": async ({ agent }) => skills()?.leftOut(agent) ?? [],
    "hostedSkills.sending": async ({ agent }) => (isHostedAgent(agent) ? (sends()?.sending(agent) ?? null) : null),
    "hostedSkills.list": async ({ agent }) => (await skills()?.catalog(agent)) ?? [],
    "hostedSkills.choose": async ({ agent, names, on }) => {
      choose(agent, names, on);
      return (await skills()?.catalog(agent)) ?? [];
    },
  };
}
