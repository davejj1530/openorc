import { retiredThreadIds } from "./retired-teams.js";

/**
 * A thread coming here from OpenOrc Cloud is hidden while its rows are written, with the threads started under it, which
 * come with it. Once they are whole they show, and their reads still go to the cloud for as long as the cloud holds
 * them, so they are never in neither place (thread-relocations.ts).
 */
const ARRIVING = `WITH RECURSIVE arriving(member) AS (
  SELECT thread_id FROM thread_relocations WHERE role = 'coordinator' AND direction = 'to-mac' AND phase = 'asking'
  UNION SELECT t.id FROM threads t JOIN arriving a ON t.parent_thread_id = a.member WHERE t.parent_relation = 'started'
) SELECT member FROM arriving`;

/** The threads a person's lists read: raw rows remain available internally, but retired and arriving ones are left out. */
export const VISIBLE = `id NOT IN (${retiredThreadIds}) AND id NOT IN (${ARRIVING})`;
