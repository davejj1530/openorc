import { discussionJourney } from "./discussion";
import { handoff } from "./handoff";
import { slackJourney } from "./slack";
import { teamJourney } from "./team";
import { workflowJourney } from "./workflow";
import type { Journey } from "./timeline";

/** The scenes, keyed by the id their SceneFrame carries. */
export const journeys = { handoff, discussion: discussionJourney, team: teamJourney, workflow: workflowJourney, slack: slackJourney } satisfies Record<string, Journey>;

export type SceneId = keyof typeof journeys;

export { moment, timed, visibleAt, type Journey, type Layout, type Timeline } from "./timeline";
