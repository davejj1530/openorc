import { BrainMachine, type BrainAccess, type BrainMachineStatus, type DoorBundle } from "@openorc/cloud";
import type { CloudBrainMachine } from "@openorc/protocol";

/** A brain this build can install. Read only when installing it, since it is tens of megabytes. */
export interface BrainBundleSource {
  version: string;
  read(): Promise<Buffer>;
  /** The door this build deploys beside the brain, which a paired phone knocks on to wake it. */
  door?: DoorBundle;
}

/** The parts of BrainMachine this Mac uses; tests pass a stand-in. Moving threads uses the transfers too. */
export type BrainMachineLike = Pick<BrainMachine, "status" | "provision" | "wake" | "control" | "importProject" | "remove"> & Partial<Pick<BrainMachine, "receiveThread" | "readOutbox" | "costSince">>;

/** The brain's machine on a team. Its project is made only when `create`; otherwise a team without one has none. */
export type OpenBrainMachine = (access: BrainAccess, create: boolean) => Promise<BrainMachineLike | null>;
export const openMachine: OpenBrainMachine = (access, create) => (create ? BrainMachine.connect(access) : BrainMachine.find(access));

/** What Settings says of the machine, by Vercel's state. */
export const shownMachine: Record<BrainMachineStatus["state"], CloudBrainMachine | "missing"> = {
  running: "awake",
  stopped: "asleep",
  starting: "starting",
  stopping: "stopping",
  failed: "failed",
  missing: "missing",
};
