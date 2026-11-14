import { hostedPanelControl } from "@openorc/client";
import { HOSTED_REASONS, type HostedUnavailableControl } from "@openorc/protocol";
import type { PanelPage } from "../lib/panel-tabs";
import { PanelBar } from "./PanelBar";
import { panelTools, type PanelContext } from "./panel-tools";
import { Button } from "./ui";
import { HostedControlReason } from "./HostedControlReason";

export function hostedUnavailablePanel(context: PanelContext, page: PanelPage) {
  if (context.kind !== "thread" || context.thread.owner?.brain !== "hosted") return null;
  const tool = unavailableTool(page);
  if (!tool) return null;
  const control = hostedPanelControl(tool);
  if (!control || control === "changes" || control === "publishing") return null;
  return <HostedUnavailablePanel title={panelTools[tool].label} control={control} />;
}

export function HostedUnavailablePanel({ title, control }: { title: string; control: HostedUnavailableControl }) {
  return (
    <div className="h-full min-h-0 flex flex-col">
      <PanelBar title={title} />
      <HostedUnavailableContent title={title} control={control} />
    </div>
  );
}

export function HostedUnavailableContent({ title, control }: { title: string; control: HostedUnavailableControl }) {
  return (
    <div className="flex-1 grid place-items-center">
      <HostedControlReason label={title} reason={HOSTED_REASONS[control]}>
        <Button variant="ghost" disabled>
          {title} unavailable
        </Button>
      </HostedControlReason>
    </div>
  );
}

function unavailableTool(page: PanelPage) {
  if (page.kind === "tool") return page.tool;
  return page.kind === "file" ? "file" : null;
}
