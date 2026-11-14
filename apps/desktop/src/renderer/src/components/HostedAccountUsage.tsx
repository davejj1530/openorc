import type { ReactNode } from "react";
import { HOSTED_REASONS } from "@openorc/protocol";
import { useRpc } from "../lib/client";
import { useRouter } from "../lib/router";
import { HostedControlReason } from "./HostedControlReason";
import { Signal } from "./icons";

/** The Mac's account allowance does not describe the sign-in used by a cloud turn. */
export function HostedAccountUsage({ children }: { children: ReactNode }) {
  const threadId = useRouter((state) => (state.route.view === "thread" ? state.route.threadId : null));
  const thread = useRpc("threads.get", { id: threadId ?? "" }, { enabled: Boolean(threadId) }).data;
  if (threadId && thread?.id !== threadId) return null;
  if (thread?.owner?.brain !== "hosted") return children;
  return (
    <HostedControlReason label="Usage" reason={HOSTED_REASONS.usage}>
      <button type="button" className="sidebar-tool account-usage-button no-drag" aria-label="Usage" disabled>
        <Signal size={16} />
      </button>
    </HostedControlReason>
  );
}
