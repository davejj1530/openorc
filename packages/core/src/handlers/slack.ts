import { SlackService } from "../services/slack/service.js";
import type { Handlers } from "./types.js";
type Dependencies = {
  slack: Pick<
    SlackService,
    | "status"
    | "saveDirect"
    | "connectDirect"
    | "disconnectDirect"
    | "saveHost"
    | "connectHost"
    | "disconnectHost"
    | "change"
    | "addDevice"
    | "removeDevice"
    | "saveClient"
    | "connectClient"
    | "disconnectClient"
  >;
  invalidate: (keys: string[]) => void;
};

export function createSlackHandlers({
  slack,
  invalidate,
}: Dependencies): Pick<
  Handlers,
  | "slack.status"
  | "slack.direct.save"
  | "slack.direct.connect"
  | "slack.direct.disconnect"
  | "slack.host.save"
  | "slack.host.connect"
  | "slack.host.disconnect"
  | "slack.device.add"
  | "slack.device.remove"
  | "slack.client.save"
  | "slack.client.connect"
  | "slack.client.disconnect"
> {
  const slackChange = (fn: () => Promise<void> | void) =>
    slack.change(async () => {
      await fn();
      invalidate(["slack"]);
      return null;
    });
  return {
    "slack.status": () => slack.status(),
    "slack.direct.save": (input) => slackChange(() => slack.saveDirect(input)),
    "slack.direct.connect": () => slackChange(() => slack.connectDirect()),
    "slack.direct.disconnect": () => slackChange(() => slack.disconnectDirect()),
    "slack.host.save": (input) => slackChange(() => slack.saveHost(input)),
    "slack.host.connect": () => slackChange(() => slack.connectHost()),
    "slack.host.disconnect": () => slackChange(() => slack.disconnectHost()),
    "slack.device.add": ({ userId, label }) =>
      slack.change(async () => {
        const result = await slack.addDevice(userId, label);
        invalidate(["slack"]);
        return result;
      }),
    "slack.device.remove": ({ id }) => slackChange(() => slack.removeDevice(id)),
    "slack.client.save": (input) => slackChange(() => slack.saveClient(input)),
    "slack.client.connect": () => slackChange(() => slack.connectClient()),
    "slack.client.disconnect": () => slackChange(() => slack.disconnectClient()),
  };
}
