import { z } from "zod";

/** What keeps a thread on a machine awake: its turn, a terminal, work its agent left running, or the rest after a turn. */
export type CloudMachineHold = "turn" | "terminal" | "background" | "resting";

/**
 * A machine awake for the person now: where it runs, since when, the hours this stretch has used (`seconds`, at its
 * size's rate), its threads and what holds each, and whether they may stop it, with why not.
 */
export type CloudMachine = {
  id: string;
  serviceName: string;
  since: number;
  seconds: number;
  threads: { id: string; title: string | null; holds: CloudMachineHold[] }[];
  stop: { can: true } | { can: false; reason: string };
};

/** The person's awake machines, or none where the server lists no machines. */
export type CloudMachines = { state: "ready"; machines: CloudMachine[] } | { state: "unavailable" };

/** Window-only: the person's machines in Settings > Cloud, and Stop. */
export const hostedMachinesRpcParams = {
  "cloudMachines.read": z.object({}).strict(),
  "cloudMachines.stop": z.object({ id: z.string().min(1) }).strict(),
};
export interface HostedMachinesRpcResults {
  "cloudMachines.read": CloudMachines;
  "cloudMachines.stop": CloudMachines;
}
