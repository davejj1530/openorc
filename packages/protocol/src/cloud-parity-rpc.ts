import { hostedConnectorsRpcParams, type HostedConnectorsRpcResults } from "./hosted-connectors.js";
import { hostedMacStartRpcParams, type HostedMacStartRpcResults } from "./hosted-mac-start.js";
import { hostedSkillsLeftRpcParams, type HostedSkillsLeftRpcResults } from "./hosted-skills-left.js";

/** Window-only reads of what a cloud thread brings from this Mac: the person's connectors, a folder's work, the skills left out. */
export const cloudParityRpcParams = { ...hostedConnectorsRpcParams, ...hostedMacStartRpcParams, ...hostedSkillsLeftRpcParams };
export interface CloudParityRpcResults extends HostedConnectorsRpcResults, HostedMacStartRpcResults, HostedSkillsLeftRpcResults {}
