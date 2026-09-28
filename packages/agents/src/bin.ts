import { harnessBinaryVariable, type HarnessId } from "@openorc/protocol";

/**
 * The harness binary to spawn: the file the user's login shell resolves,
 * handed down by the app as OPENORC_<ID>_BIN, else the bare name for PATH to
 * find.
 */
export function agentBinary(kind: HarnessId): string {
  return process.env[harnessBinaryVariable(kind)] || kind;
}
