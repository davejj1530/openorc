import type { OrganizationStorage as Storage, OrganizationStorageRead } from "@openorc/protocol";
import { formatBytes } from "@openorc/client";
import { useEffect, useState } from "react";

export interface OrganizationStorageTransport {
  get(spaceId: string): Promise<OrganizationStorageRead>;
  subscribe(spaceId: string, refresh: () => void): () => void;
}

/** The scoped Seats parent unmounts this private read when the viewer loses admin access. */
export function OrganizationStorage({ spaceId, revision, transport }: { spaceId: string; revision: string; transport: OrganizationStorageTransport }) {
  const [storage, setStorage] = useState<Storage | null>(null);
  useEffect(() => {
    let current = true;
    let reading = false;
    let again = false;
    const refresh = async () => {
      if (reading) {
        again = true;
        return;
      }
      if (!current) return;
      reading = true;
      try {
        const read = await transport.get(spaceId);
        if (current) setStorage(read.storage);
      } catch {
        if (current) setStorage(null);
      } finally {
        reading = false;
        if (again && current) {
          again = false;
          void refresh();
        }
      }
    };
    setStorage(null);
    const stop = transport.subscribe(spaceId, () => void refresh());
    void refresh();
    return () => {
      current = false;
      stop();
    };
  }, [spaceId, revision, transport]);
  return storage ? (
    <p className="seats-storage">
      {storageBytes(storage.usedBytes)} of {storageBytes(storage.allowanceBytes)} used
    </p>
  ) : null;
}

function storageBytes(bytes: number): string {
  return formatBytes(bytes)
    .replace(/(\d+)\.0+(?= )/, "$1")
    .replace(/(\.\d*?[1-9])0+(?= )/, "$1");
}
