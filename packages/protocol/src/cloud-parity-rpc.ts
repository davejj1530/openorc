import { hostedConnectorsRpcParams, type HostedConnectorsRpcResults } from "./hosted-connectors.js";
import { hostedMacStartRpcParams, type HostedMacStartRpcResults } from "./hosted-mac-start.js";
import { hostedSkillsCloudRpcParams, type HostedSkillsCloudRpcResults } from "./hosted-skills-cloud.js";

/** Window-only reads of what a cloud thread brings from this Mac: the person's connectors, a folder's work, the skills that go and the ones left out. */
export const cloudParityRpcParams = { ...hostedConnectorsRpcParams, ...hostedMacStartRpcParams, ...hostedSkillsCloudRpcParams };
export interface CloudParityRpcResults extends HostedConnectorsRpcResults, HostedMacStartRpcResults, HostedSkillsCloudRpcResults {}
