import path from "node:path";
import { Worker } from "node:worker_threads";
import { WorkerEmbedder, ownerLinkKeys, pathProbe, type OpenOrcOptions, type Transport } from "@openorc/core";
import { brainDoor, type BrainDoorKey, type BrainKey, type BrainLayout, type BrainSelf, type BrainStart, type RunnerFile } from "@openorc/cloud";
import { brainPath } from "./machine-check.js";
import type { SealedSecrets } from "./secrets.js";

export interface BrainOptionsInput {
  layout: BrainLayout;
  /** The real folder of the running version, where the embedder's worker sits. */
  appDir: string;
  start: BrainStart;
  /** The brain's own sandbox: thread sandboxes are made in its region, beside it. */
  self: Pick<BrainSelf, "region">;
  secrets: SealedSecrets;
  transport: Transport;
  runnerFiles: RunnerFile[];
}

/** Each phone's key to the brain's door: this epoch's ticket for the asking phone's own device id. */
function doorKeys(key: BrainKey): (deviceId: string) => BrainDoorKey {
  const door = brainDoor(key);
  return (deviceId) => door.key(deviceId, Date.now());
}

/**
 * What the brain passes the core. Every conversation runs in a cloud sandbox, made with the Vercel connection from
 * this start, which is held in memory only. Phones reach the brain only through the proxy at its public address.
 *
 * Left out on purpose: browser and preview (there are none here); presence (always away, so every alert reaches
 * phones); a terminal (sign-ins arrive by handover, so no node-pty and no compiler); the bundled formatter; cloudOffered
 * (every conversation is cloud, so there is no place to choose); a file key; benchmarks.
 */
export function brainOptions({ layout, appDir, start, self, secrets, transport, runnerFiles }: BrainOptionsInput): OpenOrcOptions {
  return {
    dataDir: layout.data,
    transport,
    ...secrets.stores(),
    remoteNetwork: {
      port: start.port,
      publicAddress: start.address,
      machine: { name: () => start.name, lanHosts: () => [], tailnetHosts: async () => [] },
      // Only a brain on Vercel has a door; one in a local container stays up while it runs.
      ...(start.vercel ? { door: doorKeys(start.key) } : {}),
      owner: ownerLinkKeys(start.key).publicKey,
    },
    shellProbe: pathProbe({ PATH: brainPath(layout) }),
    // The embedding model runs in its own thread, so loading it and embedding memories never stall the core.
    embedder: new WorkerEmbedder(() => new Worker(path.join(appDir, "embedder-worker.mjs"), { workerData: { cacheDir: layout.data } })),
    cloudOnly: true,
    deviceSystem: null,
    cloudCredentials: async () => (start.vercel ? { ...start.vercel.connection, region: await self.region() } : null),
    cloudRunnerFiles: runnerFiles,
  };
}
