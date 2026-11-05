// What the brain's door function runs, apart from the package's index, so its one-file bundle carries only the wake.
export { BrainMachine, type WakeResult } from "./brain/machine.js";
export { brainDoor, ticketStanding } from "./brain/door.js";
export { readDoorConfig, type DoorConfig } from "./brain/wire.js";
export { vercelDenied } from "./vercel-projects.js";
