import { useId } from "react";
import { Button, Switch } from "./ui";
import { queryClient, useRpc, useRpcMutation } from "../lib/query";
import { extractionSummary } from "../lib/memory-extraction";
import "./memory.css";

/** Show the acknowledged policy, never an optimistic Off claim after a failed save. */
export function MemoryControl({ compact = false }: { compact?: boolean }) {
  const settings = useRpc("memory.settings.get", {});
  const save = useRpcMutation("memory.settings.set");
  const descriptionId = useId();
  const enabled = settings.data?.enabled;
  const extraction = settings.data ? extractionSummary(settings.data) : null;
  let heading = "Checking memory status…";
  let description = "Loading your saved preference.";
  if (enabled === true) {
    heading = "OpenOrc memory is on";
    description = "Agents can save and recall useful knowledge across conversations.";
  } else if (enabled === false) {
    heading = "OpenOrc memory is off";
    description = "Saved memories are retained for you to review, but OpenOrc won’t save or recall them.";
  }
  const commit = (value: boolean) =>
    save.mutate(
      { enabled: value },
      {
        onSuccess: (result) => queryClient.setQueryData(["memory.settings.get", {}], result),
      },
    );
  if (settings.isError)
    return (
      <div className="memory-control" role="alert">
        Could not check memory status.{" "}
        <Button size="sm" onClick={() => void settings.refetch()}>
          Try again
        </Button>
      </div>
    );
  return (
    <section className="memory-control" aria-label="OpenOrc memory status" aria-busy={settings.isLoading || save.isPending}>
      <div className="memory-control-row">
        <div className="min-w-0">
          <h2 className="text-md font-semibold">{heading}</h2>
          <p id={descriptionId} className="text-base text-ink-2 mt-1">
            {description}
          </p>
          {extraction && <p className="text-base text-ink-2 mt-1">{extraction}</p>}
        </div>
        {!compact && (
          <Switch
            aria-label="OpenOrc memory"
            aria-describedby={descriptionId}
            checked={enabled === true}
            disabled={enabled === undefined || save.isPending}
            onChange={(e) => commit(e.target.checked)}
          />
        )}
      </div>
      {!compact && <p className="text-sm text-ink-3 mt-3">Applies to all projects. Native harness memory is managed separately. Memories already in a conversation remain in its context.</p>}
      {save.isPending && (
        <p className="text-sm text-ink-2 mt-2" role="status">
          Saving memory preference…
        </p>
      )}
      {save.isError && (
        <p className="text-sm text-bad mt-2" role="alert">
          Could not change memory. Your previous setting is still active.{" "}
          <Button size="sm" onClick={() => commit(save.variables?.enabled ?? !enabled)}>
            Retry save
          </Button>
        </p>
      )}
    </section>
  );
}
