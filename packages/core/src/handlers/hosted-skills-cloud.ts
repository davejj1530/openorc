import type { HarnessId, HostedSkillsCloudRpcResults } from "@openorc/protocol";
import type { AppSettingsService } from "../services/settings.js";
import type { HostedSkills } from "../services/hosted-skills.js";
import type { Handlers } from "./types.js";

/**
 * An agent's skills for the cloud and the person's choice of which go, kept on this Mac (`cloudSkillsOff`); and the
 * skills its last cloud set left out, with why: none before a cloud send. Without OpenOrc Cloud there are none.
 */
export function createHostedSkillsCloudHandlers(skills: () => HostedSkills | null, settings: AppSettingsService): Pick<Handlers, keyof HostedSkillsCloudRpcResults> {
  const choose = (agent: HarnessId, names: readonly string[], on: boolean) => {
    const all = settings.get().cloudSkillsOff;
    const others = (all[agent] ?? []).filter((name) => !names.includes(name));
    settings.set({ cloudSkillsOff: { ...all, [agent]: on ? others : [...others, ...names] } });
  };
  return {
    "hostedSkills.leftOut": async ({ agent }) => skills()?.leftOut(agent) ?? [],
    "hostedSkills.list": async ({ agent }) => (await skills()?.catalog(agent)) ?? [],
    "hostedSkills.choose": async ({ agent, names, on }) => {
      choose(agent, names, on);
      return (await skills()?.catalog(agent)) ?? [];
    },
  };
}
