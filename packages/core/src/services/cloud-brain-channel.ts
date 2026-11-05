import type { CloudBrain } from "./cloud-brain.js";
import type { BrainChannel } from "./relocation-coordinator.js";

const NOT_ON = "Switch this project on for the cloud brain in Settings > Cloud first.";
const NO_COPY = "The cloud brain doesn't have this project's copy yet. Try again once it's sent.";

/** The cloud brain as moving threads sees it: the Mac's own CloudBrain, its operations in turn with the rest. */
export function brainChannel(brain: CloudBrain): BrainChannel {
  return {
    ready: async () => (await brain.moves()) !== null,
    copy: async (macProject) => {
      const record = (await brain.moves())?.projects.find((each) => each.id === macProject);
      if (!record) return { missing: NOT_ON };
      return record.brainId ? { sent: record.sent } : { missing: NO_COPY };
    },
    awake: (work) =>
      brain.withMachine(true, (machine) => {
        const { receiveThread, readOutbox } = machine;
        if (!receiveThread || !readOutbox) throw new Error("The cloud brain can't move conversations.");
        return work({
          receive: (relocation, bytes) => receiveThread.call(machine, relocation, bytes),
          ask: (request) => machine.control(request),
          download: (file) => readOutbox.call(machine, file),
        });
      }),
    gone: () => brain.machineGone(),
  };
}
