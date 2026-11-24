import { DEVICE } from "../device";

/** Why a phone sends no files to an OpenOrc Cloud thread: they go through its own session there, which it does not hold. */
export const NO_CLOUD_FILES = `This ${DEVICE} isn't signed in to OpenOrc Cloud.`;
