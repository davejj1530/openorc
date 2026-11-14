import { createContext, useContext, type ReactNode } from "react";
import { hostedControlReason, type HostedControl } from "@openorc/client";
import type { ThreadSummary } from "@openorc/protocol";

const HostedConversation = createContext<ThreadSummary | null>(null);

/** The transcript and composer share the thread's place without changing local controls. */
export function HostedConversationBoundary({ thread, children }: { thread: ThreadSummary; children: ReactNode }) {
  return <HostedConversation.Provider value={thread}>{children}</HostedConversation.Provider>;
}

export function useHostedControlReason(control: HostedControl): string | null {
  return hostedControlReason(useContext(HostedConversation), control);
}
