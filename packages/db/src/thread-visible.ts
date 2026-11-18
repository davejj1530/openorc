import { retiredThreadIds } from "./retired-teams.js";

/**
 * A thread coming here from OpenOrc Cloud is hidden while its rows are written. Once they are whole it shows, and its
 * reads still go to the cloud for as long as the cloud holds it, so it is never in neither place (thread-relocations.ts).
 */
const ARRIVING = "SELECT thread_id FROM thread_relocations WHERE role = 'coordinator' AND direction = 'to-mac' AND phase = 'asking'";

/** The threads a person's lists read: raw rows remain available internally, but retired and arriving ones are left out. */
export const VISIBLE = `id NOT IN (${retiredThreadIds}) AND id NOT IN (${ARRIVING})`;
