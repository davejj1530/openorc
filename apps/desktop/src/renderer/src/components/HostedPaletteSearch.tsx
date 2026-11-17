import { useHostedCapabilities } from "../hooks/useHostedCapabilities";
import { Command } from "cmdk";
import { HOSTED_REASONS } from "@openorc/protocol";
import { useRpc } from "../lib/client";
import { useRouter } from "../lib/router";
import { useSpaceRpc } from "../lib/space-queries";
import { HostedControlReason } from "./HostedControlReason";

/**
 * The palette's message search, of this Mac's threads and the space's cloud threads alike: the space's `threads.search`
 * reaches both. `hits` are shown once the open thread's place is known. `reason` is why it could not search, when a
 * cloud server without the search says so; `newFileReason` why New file can't make a file in the open cloud thread.
 */
export function usePaletteSearch(open: boolean, query: string) {
  const threadId = useRouter(({ route }) => (route.view === "thread" ? route.threadId : null));
  const thread = useRpc("threads.get", { id: threadId ?? "" }, { enabled: open && Boolean(threadId) });
  const ready = !threadId || thread.isSuccess;
  // Messages match by prefix from two characters on, across every thread's conversation.
  // In the window's space, so its cloud threads are searched where they are kept, beside this Mac's.
  const hits = useSpaceRpc("threads.search", { query, limit: 20 }, { enabled: open && ready && query.trim().length >= 2, staleTime: 5_000 });
  const reason = hits.error?.message === HOSTED_REASONS.search ? HOSTED_REASONS.search : null;
  // Until the open thread's place is known, nothing found earlier is shown.
  const newFileReason = useHostedCapabilities(thread.data).reason("fileWrite");
  return { hits: ready && !reason ? (hits.data ?? []) : [], reason, newFileReason, fetching: hits.isFetching };
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
