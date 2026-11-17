import { hostedConnectorsRpcParams, type HostedConnectorsRpcResults } from "./hosted-connectors.js";
import { hostedMacStartRpcParams, type HostedMacStartRpcResults } from "./hosted-mac-start.js";
import { hostedMachinesRpcParams, type HostedMachinesRpcResults } from "./hosted-machines.js";
import { hostedCheckRpcParams, type HostedCheckRpcResults } from "./hosted-check.js";
import { hostedMacProjectsRpcParams, type HostedMacProjectsRpcResults } from "./hosted-mac-projects.js";
import { hostedSkillsCloudRpcParams, type HostedSkillsCloudRpcResults } from "./hosted-skills-cloud.js";
import { cloudMovesRpcParams, type CloudMovesRpcResults } from "./cloud-moves.js";
import { hostedModelsRpcParams, type HostedModelsRpcResults } from "./hosted-models.js";

/** Window-only reads of what a cloud thread brings from this Mac: the person's connectors, a folder's work, the skills that go and the ones left out, the machines awake for them, the cloud check. */
export const cloudParityRpcParams = {
  ...hostedConnectorsRpcParams,
  ...hostedMacStartRpcParams,
  ...hostedSkillsCloudRpcParams,
  ...hostedMachinesRpcParams,
  ...hostedCheckRpcParams,
  ...hostedMacProjectsRpcParams,
  ...cloudMovesRpcParams,
  ...hostedModelsRpcParams,
};
export interface CloudParityRpcResults
  extends
    HostedConnectorsRpcResults,
    HostedMacStartRpcResults,
    HostedSkillsCloudRpcResults,
    HostedMachinesRpcResults,
    HostedCheckRpcResults,
    HostedMacProjectsRpcResults,
    CloudMovesRpcResults,
    HostedModelsRpcResults {}
