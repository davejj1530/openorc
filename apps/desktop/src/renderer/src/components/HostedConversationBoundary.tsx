import { createContext, useContext, type ReactNode } from "react";
import type { HostedControl } from "@openorc/client";
import type { ThreadSummary } from "@openorc/protocol";
import { useHostedCapabilities } from "../hooks/useHostedCapabilities";

const HostedConversation = createContext<ThreadSummary | null>(null);

/** The transcript and composer share the thread's place without changing local controls. */
export function HostedConversationBoundary({ thread, children }: { thread: ThreadSummary; children: ReactNode }) {
  return <HostedConversation.Provider value={thread}>{children}</HostedConversation.Provider>;
}

/** Why a control is held in this cloud conversation, as its server's capabilities say for the controls it serves; null on this Mac. */
export function useHostedControlReason(control: HostedControl): string | null {
  return useHostedCapabilities(useContext(HostedConversation)).reason(control);
}

export function useHostedConversation(): ThreadSummary | null {
  return useContext(HostedConversation);
}
