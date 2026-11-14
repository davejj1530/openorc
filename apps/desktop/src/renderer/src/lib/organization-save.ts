import { useEffect, useRef, useState } from "react";
import type { OrganizationIdentity } from "@openorc/protocol";
import type { OrganizationSaved } from "../dialogs/OrganizationIdentityDialog";
import { useRpc, useRpcMutation } from "./client";

/** Once the write succeeds, only its following read may be retried. */
export function useOrganizationSave({
  organization,
  name,
  logo,
  onSaved,
  close,
}: {
  organization?: OrganizationIdentity;
  name: string;
  logo: string | null;
  onSaved(result: OrganizationSaved, signal: AbortSignal): void | Promise<void>;
  close(): void;
}) {
  const create = useRpcMutation("spaces.create");
  const update = useRpcMutation("organization.update");
  const status = useRpc("spaces.status", {}).data;
  const latest = useRef(status);
  latest.current = status;
  const completed = useRef<OrganizationSaved | null>(null);
  const controller = useRef(new AbortController());
  const busy = useRef(false);
  const after = useRef(0);
  const [saved, setSaved] = useState<OrganizationSaved | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const current = new AbortController();
    controller.current = current;
    return () => current.abort();
  }, []);
  const submit = async () => {
    if (busy.current || !name.trim()) return;
    busy.current = true;
    setPending(true);
    setError(null);
    try {
      if (!completed.current) {
        const result = organization
          ? { spaceId: (await update.mutateAsync({ spaceId: organization.id, name, ...(logo !== organization.logo ? { logo } : {}) })).id, logoError: null }
          : await create.mutateAsync({ name, ...(logo ? { logo } : {}) });
        completed.current = { ...result, pendingLogo: result.logoError ? logo : null };
        setSaved(completed.current);
      }
      if (controller.current.signal.aborted) return;
      await onSaved(completed.current, controller.current.signal);
      if (!controller.current.signal.aborted) close();
    } catch (error) {
      after.current = latest.current?.state === "ready" ? latest.current.heardAt : 0;
      if (!controller.current.signal.aborted) setError(error instanceof Error ? error.message : "OpenOrc Cloud can't be reached.");
    } finally {
      busy.current = false;
      if (!controller.current.signal.aborted) setPending(false);
    }
  };
  useEffect(() => {
    if (saved && error && !pending && status?.state === "ready" && !status.error && status.heardAt > after.current && status.spaces.some((space) => space.id === saved.spaceId)) void submit();
  });
  return { saved, pending, error, submit, setError };
}
