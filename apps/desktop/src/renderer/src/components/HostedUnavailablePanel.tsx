import { hostedPanelControl, type HostedControl } from "@openorc/client";
import type { PanelPage } from "../lib/panel-tabs";
import { PanelBar } from "./PanelBar";
import { panelTools, type PanelContext } from "./panel-tools";
import { Button } from "./ui";
import { HostedControlReason } from "./HostedControlReason";

/** A cloud thread's tool held back, with `reason`'s words for it: a tool the cloud lacks, or one its server does not serve. */
export function hostedUnavailablePanel(context: PanelContext, page: PanelPage, reason: (control: HostedControl) => string | null) {
  if (context.kind !== "thread" || context.thread.owner?.brain !== "hosted") return null;
  const tool = unavailableTool(page);
  if (!tool) return null;
  const control = hostedPanelControl(tool);
  // Changes, publishing and the terminal read the server themselves, and say its reason when it has one.
  if (!control || control === "changes" || control === "publishing" || control === "terminal") return null;
  const why = reason(control);
  return why ? <HostedUnavailablePanel title={panelTools[tool].label} reason={why} /> : null;
}

export function HostedUnavailablePanel({ title, reason }: { title: string; reason: string }) {
  return (
    <div className="h-full min-h-0 flex flex-col">
      <PanelBar title={title} />
      <HostedUnavailableContent title={title} reason={reason} />
    </div>
  );
}

export function HostedUnavailableContent({ title, reason }: { title: string; reason: string }) {
  return (
    <div className="flex-1 grid place-items-center">
      <HostedControlReason label={title} reason={reason}>
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
