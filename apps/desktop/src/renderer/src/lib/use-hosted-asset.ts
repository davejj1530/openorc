import { useEffect, useMemo, useSyncExternalStore } from "react";
import { hostedFilesRpcParams, type HostedFileRef, type HostedFileScope } from "@openorc/protocol";
import { HostedAssetLease } from "./hosted-asset-lease";
import { organizationContentGate, startOrganizationContentGate } from "./organization-content-gate";
import { core } from "./rpc";

type Source = { kind: "draft"; ref: HostedFileRef } | { kind: "thumbnail"; scope: HostedFileScope; file: { id: string; name: string } };

/** Preview bytes are bounded by core; the full original never becomes a renderer Blob. */
export function useHostedAsset(source: Source | null) {
  const key = JSON.stringify(source);
  const lease = useMemo(() => {
    const captured = sourceFromKey(key);
    return new HostedAssetLease({ read: () => read(captured), create: rasterUrl, revoke: (url) => URL.revokeObjectURL(url) });
  }, [key]);
  const state = useSyncExternalStore(lease.subscribe, lease.getSnapshot);
  useEffect(() => {
    if (key === "null") return;
    const stopGate = startOrganizationContentGate();
    let generation = organizationContentGate.getSnapshot().generation;
    const authority = organizationContentGate.subscribe(() => {
      const next = organizationContentGate.getSnapshot().generation;
      if (next !== generation) {
        generation = next;
        lease.refresh();
      }
    });
    const pushes = core.onPush((push) => {
      if (push.type === "session" || (push.type === "invalidate" && push.keys.includes("hostedAssets"))) lease.refresh();
    });
    lease.start();
    return () => {
      authority();
      pushes();
      stopGate();
      lease.close();
    };
  }, [lease, key]);
  return { state, retry: lease.refresh, failed: lease.failed, onInvalidated: lease.onInvalidated };
}

function sourceFromKey(key: string): Source | null {
  const source: unknown = JSON.parse(key);
  if (!source || typeof source !== "object" || !("kind" in source)) return null;
  if (source.kind === "draft" && "ref" in source) return { kind: "draft", ref: hostedFilesRpcParams["hostedFiles.preview"].parse(source.ref) };
  if (source.kind === "thumbnail" && "scope" in source && "file" in source)
    return { kind: "thumbnail", ...hostedFilesRpcParams["hostedFiles.thumbnail"].parse({ scope: source.scope, file: source.file }) };
  return null;
}

async function read(source: Source | null) {
  if (!source) return null;
  const scope = source.kind === "draft" ? source.ref.scope : source.scope;
  const guard = organizationContentGate.capture(scope.spaceId, scope.accountId);
  try {
    const result = source.kind === "draft" ? await core.call("hostedFiles.preview", source.ref) : await core.call("hostedFiles.thumbnail", { scope, file: source.file });
    return guard.current() ? result : null;
  } catch (error) {
    if (error instanceof Error && error.message === "That file has no thumbnail.") return null;
    throw error;
  }
}

function rasterUrl({ contentType, data }: { contentType: string; data: string }): string {
  const bytes = Uint8Array.from(atob(data), (character) => character.charCodeAt(0));
  return URL.createObjectURL(new Blob([bytes], { type: contentType }));
}
