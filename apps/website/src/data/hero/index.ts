import { discussionJourney } from "./discussion";
import { handoff } from "./handoff";
import { slackJourney } from "./slack";
import type { Journey } from "./timeline";
import { workflowJourney } from "./workflow";

/** The scenes, keyed by the id their SceneFrame carries. */
export const journeys = { handoff, discussion: discussionJourney, workflow: workflowJourney, slack: slackJourney } satisfies Record<string, Journey>;

export type SceneId = keyof typeof journeys;

export { duration, elapsed, flagged, moment, restingStates, stateAt, timed, visibleAt, type Journey, type Layout, type Timeline } from "./timeline";
