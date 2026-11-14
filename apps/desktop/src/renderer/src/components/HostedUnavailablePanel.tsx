import { hostedPanelControl } from "@openorc/client";
import { HOSTED_REASONS, type HostedUnavailableControl } from "@openorc/protocol";
import type { PanelPage } from "../lib/panel-tabs";
import { PanelBar } from "./PanelBar";
import { panelTools, type PanelContext } from "./panel-tools";
import { Empty } from "./ui";

export function hostedUnavailablePanel(context: PanelContext, page: PanelPage) {
  if (context.kind !== "thread" || context.thread.owner?.brain !== "hosted") return null;
  const tool = page.kind === "tool" ? page.tool : page.kind === "file" ? "file" : null;
  if (!tool) return null;
  const control = hostedPanelControl(tool);
  if (!control || control === "changes" || control === "publishing") return null;
  return <HostedUnavailablePanel title={panelTools[tool].label} control={control} />;
}

export function HostedUnavailablePanel({ title, control }: { title: string; control: HostedUnavailableControl }) {
  return (
    <div className="h-full min-h-0 flex flex-col">
      <PanelBar title={title} />
      <Empty title={`${title} unavailable`}>{HOSTED_REASONS[control]}</Empty>
    </div>
  );
}
