import { Button } from "./ui";
import { PanelBar, PanelBarMeta, PanelNotice } from "./PanelBar";
import { useRpc } from "../lib/client";
import { extractionSummary } from "../lib/memory-extraction";

/** The Memory tool's bar: whether memory is on, as last acknowledged, and what summarizes runs. Settings owns the switch. */
export function MemoryStatusBar() {
  const settings = useRpc("memory.settings.get", {});
  const enabled = settings.data?.enabled;
  const extraction = settings.data ? extractionSummary(settings.data) : null;
  let state = "Checking…";
  if (enabled === true) state = "On";
  else if (enabled === false) state = "Off, saved memories are kept for review";
  return (
    <section aria-label="OpenOrc memory status" aria-busy={settings.isLoading} className="shrink-0">
      <PanelBar title="Memory" meta={settings.isError ? null : <PanelBarMeta>{state}</PanelBarMeta>} />
      {settings.isError ? (
        <PanelNotice role="alert">
          Could not check memory status.{" "}
          <Button size="sm" onClick={() => void settings.refetch()}>
            Try again
          </Button>
        </PanelNotice>
      ) : null}
      {extraction && enabled ? <PanelNotice>{extraction}</PanelNotice> : null}
    </section>
  );
}
