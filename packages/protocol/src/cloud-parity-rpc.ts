import { hostedConnectorsRpcParams, type HostedConnectorsRpcResults } from "./hosted-connectors.js";
import { hostedMacStartRpcParams, type HostedMacStartRpcResults } from "./hosted-mac-start.js";
import { hostedMachinesRpcParams, type HostedMachinesRpcResults } from "./hosted-machines.js";
import { hostedSkillsCloudRpcParams, type HostedSkillsCloudRpcResults } from "./hosted-skills-cloud.js";

/** Window-only reads of what a cloud thread brings from this Mac: the person's connectors, a folder's work, the skills that go and the ones left out, the machines awake for them. */
export const cloudParityRpcParams = { ...hostedConnectorsRpcParams, ...hostedMacStartRpcParams, ...hostedSkillsCloudRpcParams, ...hostedMachinesRpcParams };
export interface CloudParityRpcResults extends HostedConnectorsRpcResults, HostedMacStartRpcResults, HostedSkillsCloudRpcResults, HostedMachinesRpcResults {}
