import type { HostedFileScope } from "@openorc/protocol";
import { useQuery } from "@tanstack/react-query";
import { createContext } from "react";
import { cloud } from "../client";
import { cloudFileScope, type CloudPlace } from "./cloud-upload";
import { useOwnCloud } from "./use-own-cloud";
import { NO_CLOUD_FILES } from "./words";

/** The open cloud thread's place, for reading the files its messages carry; null outside one. */
export const CloudFileScopeContext = createContext<HostedFileScope | null>(null);

/**
 * Whether files can go to this place now, through the phone's own session: where (`scope`), or why not (`refusal`,
 * the server's words, or that the phone does not reach OpenOrc Cloud itself). Both null while the server's answer is
 * on its way. `readable`: the place itself, where the files its messages carry are read, whatever the server says of
 * sending more.
 */
export function useCloudFiles(place: CloudPlace | null): { scope: HostedFileScope | null; refusal: string | null; readable: HostedFileScope | null } {
  const own = useOwnCloud();
  const hosted = own ? cloud.hosted : null;
  const scope = hosted && place ? cloudFileScope(hosted, place) : null;
  const availability = useQuery({
    queryKey: ["cloud.files.availability", scope?.accountId, scope?.spaceId],
    queryFn: () => hosted!.files.availability(scope!),
    enabled: Boolean(hosted && scope),
    staleTime: 5 * 60_000,
  });
  if (!place) return { scope: null, refusal: null, readable: null };
  if (!hosted || !scope) return { scope: null, refusal: NO_CLOUD_FILES, readable: scope };
  if (!availability.data) return { scope: null, refusal: availability.error ? availability.error.message : null, readable: scope };
  return availability.data.available ? { scope, refusal: null, readable: scope } : { scope: null, refusal: availability.data.reason, readable: scope };
}

/**
 * Where an open thread's images go and why they cannot: a cloud thread's to OpenOrc Cloud through the phone's own
 * session, refused in the server's words while it takes none (dimmed, unsaid, while that is not known yet); a thread of
 * the Mac's to the Mac. `readable`: where the files its messages carry are read.
 */
export function useThreadFiles(cloudThreadId: string | null): { attachTo: HostedFileScope | null; attachRefusal: string | null; readable: HostedFileScope | null } {
  const files = useCloudFiles(cloudThreadId === null ? null : { threadId: cloudThreadId });
  const attachRefusal = cloudThreadId !== null && !files.scope ? (files.refusal ?? "") : null;
  return { attachTo: files.scope, attachRefusal, readable: files.readable };
}
