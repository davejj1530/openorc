import { readDoorConfig } from "@openorc/cloud/door";
import { waitUntil } from "@vercel/functions";
import { doorHandler, wakeThroughDoor } from "./door.js";

// The door function's entry, bundled into one file by build.mjs and deployed by the Mac as api/door.mjs.
const log = (line: string) => console.log(line);
const handler = doorHandler({ config: readDoorConfig(process.env["OPENORC_DOOR"]), wake: (config) => wakeThroughDoor(config, log), now: Date.now, waitUntil, log });

export { handler as GET, handler as POST };
