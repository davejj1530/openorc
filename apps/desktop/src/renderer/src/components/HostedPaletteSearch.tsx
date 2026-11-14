import { Command } from "cmdk";
import { HOSTED_REASONS } from "@openorc/protocol";
import { useRpc } from "../lib/client";
import { useOrganization } from "../lib/organization-context";
import { useRouter } from "../lib/router";
import { HostedControlReason } from "./HostedControlReason";

export function useHostedPaletteSearch(open: boolean, query: string) {
  const threadId = useRouter(({ route }) => (route.view === "thread" ? route.threadId : null));
  const thread = useRpc("threads.get", { id: threadId ?? "" }, { enabled: open && Boolean(threadId) });
  const organization = useOrganization();
  const hosted = thread.data?.owner?.brain === "hosted" || Boolean(organization?.organization);
  const ready = !threadId || thread.isSuccess;
  return { reason: hosted ? HOSTED_REASONS.search : null, enabled: open && ready && !hosted && query.trim().length >= 2 };
}

export function HostedPaletteUnavailable({ label, reason }: { label: string; reason: string }) {
  return (
    <Command.Item disabled forceMount value={label}>
      <HostedControlReason label={label} reason={reason}>
        <button type="button" className="command-palette-item" disabled>
          {label}
        </button>
      </HostedControlReason>
    </Command.Item>
  );
}
