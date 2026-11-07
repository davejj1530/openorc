import { QueryClientProvider } from "@tanstack/react-query";
import { useCallback, useContext, useEffect, type ReactElement, type ReactNode } from "react";
import { hostClient, openedOn, useHostGroup } from "../client";
import { HostContext } from "./host-context";

export { screenHost } from "./HostScope.helpers";

/**
 * The host a subtree talks to: its reads, writes and runs go to that host's client. `opened` marks a screen the person
 * opened, which may wake its host; a section listed on Home does not.
 */
export function HostScope({ host, opened = false, children }: { host: string | null; opened?: boolean; children: ReactNode }) {
  // Read so a scope follows the group: a partner that stops being one falls back to the shown host.
  const { partner } = useHostGroup();
  useEffect(() => (opened ? openedOn(host) : undefined), [opened, host, partner]);
  return <HostProviders host={host}>{children}</HostProviders>;
}

function HostProviders({ host, children }: { host: string | null; children: ReactNode }) {
  return (
    <HostContext.Provider value={host}>
      <QueryClientProvider client={hostClient(host).queryClient}>{children}</QueryClientProvider>
    </HostContext.Provider>
  );
}

/**
 * Header parts the navigator draws outside the screen's tree, so they would read the shown host: wrapped, they talk to
 * the screen's host and its query cache as the screen does, as a cloud thread's title and its link state must.
 */
export function useHeaderScope(): (part: ReactElement) => ReactElement {
  const host = useContext(HostContext);
  return useCallback((part: ReactElement) => <HostProviders host={host}>{part}</HostProviders>, [host]);
}
