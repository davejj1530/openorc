import { useState } from "react";
import type { CloudSignIn, CloudSignIns } from "@openorc/protocol";
import { Button, Dialog } from "../components/ui";
import { queryClient, useRpcMutation } from "../lib/client";
import { Failure } from "./settings-secret-field";
import { SettingRow, Status } from "./settings-shared";

const shown = (signIns: CloudSignIns) => queryClient.setQueryData(["cloud.signIns", {}], signIns);

/** What a copy takes from this Mac, for the confirm. */
function copyName(row: CloudSignIn): string {
  if (row.kind === "codex") return "Codex's API key";
  if (row.kind === "brain-codex") return "Codex's API key for the cloud brain";
  if (row.kind === "github") return "your GitHub sign-in";
  return `OpenCode's ${row.label} key`;
}

const listed = (names: string[]) => (names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);

/** What bringing would change now: the rows a browser or a copy makes ready. */
export function missingRows(signIns: CloudSignIns | undefined): CloudSignIn[] {
  return (signIns?.rows ?? []).filter((row) => row.way !== "key" && (row.state === "missing" || row.state === "failed"));
}

/** A row names its agent where the name alone could be another's: Claude's accounts beside OpenCode's providers. */
export function signInTitle(row: CloudSignIn): string {
  if (row.kind === "claude") return `Claude · ${row.label}`;
  return row.kind === "opencode" ? `OpenCode · ${row.label}` : row.label;
}

/**
 * The one button that brings every missing sign-in, one at a time. Copies of this Mac's keys go only after the person
 * says yes to the list of them; without it, only the browser sign-ins run.
 */
export function BringMissing({ signIns, label = "Sign-ins" }: { signIns: CloudSignIns; label?: string }) {
  const bringAll = useRpcMutation("cloud.signIns.bringAll");
  const cancel = useRpcMutation("cloud.signIns.cancel");
  const [asking, setAsking] = useState(false);
  const missing = missingRows(signIns);
  const copies = missing.filter((row) => row.way === "copy");
  const start = (copy: boolean) => {
    setAsking(false);
    bringAll.mutate({ copy }, { onSuccess: shown });
  };
  if (signIns.bringing)
    return (
      <SettingRow label={label}>
        <Status>Signing in</Status>
        <Button variant="ghost" disabled={cancel.isPending} onClick={() => cancel.mutate({}, { onSuccess: shown })}>
          Cancel
        </Button>
      </SettingRow>
    );
  if (!missing.length) return null;
  return (
    <>
      <SettingRow label={label} hint={missing.length === 1 ? "1 missing" : `${missing.length} missing`}>
        <Button variant="primary" disabled={bringAll.isPending} onClick={() => (copies.length ? setAsking(true) : start(false))}>
          Bring them
        </Button>
      </SettingRow>
      <Failure error={bringAll.error ?? cancel.error} />
      <Dialog open={asking} onOpenChange={setAsking} title="Copy from this Mac?">
        <div className="space-y-3">
          <p className="text-ink-2">The cloud gets a copy of {listed(copies.map(copyName))}.</p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => start(false)}>
              Don't copy
            </Button>
            <Button variant="primary" onClick={() => start(true)}>
              Copy
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
