import type { Db } from "@openorc/db";
import type { Logger } from "../transport.js";
import type { OpenOrcOptions } from "../options.js";
import { liveAutomationSources } from "./automation-sources.js";
import { AutomationService } from "./automations.js";
import { BoardJobs } from "./board-jobs.js";
import type { Notification } from "./run-types.js";
import { TaskAgents } from "./task-agents.js";
import { TaskReports } from "./task-reports.js";
import type { Hosted } from "@openorc/hosted";
import { TeamColumnRuns } from "./team-column-runs.js";
import { TriggerValues } from "./trigger-values.js";
import type { ThreadService } from "./threads.js";

/**
 * What the app does with tasks by itself: the updates agents post on them, the agents a board's columns start, and the
 * rules that wait for something to happen.
 */
export interface TaskAutomation {
  reports: TaskReports;
  board: BoardJobs;
  rules: AutomationService;
  /** Team boards' column agents asked of this person, run here. */
  team: TeamColumnRuns;
  start(): void;
  stop(): void;
}

type Dependencies = {
  db: Db;
  /**
   * Where tasks keep their files; where the rules read what happened outside the app, GitHub and the project's own shell
   * unless a test stands in; and where the values trigger programs read are kept.
   */
  options: Pick<OpenOrcOptions, "dataDir" | "automationSources" | "automationSecrets">;
  threads: ThreadService;
  /** The signed-in OpenOrc account, whose team boards' column agents may wait for this computer. */
  account: () => Pick<Hosted, "taskRuns" | "spaces"> | null;
  invalidate: (keys: string[]) => void;
  notify: (n: Omit<Notification, "type">) => void;
  log: Logger;
};

export function createTaskAutomation({ db, options, threads, account, invalidate, notify, log }: Dependencies): TaskAutomation {
  const { dataDir, automationSources: sources = liveAutomationSources } = options;
  const reports = new TaskReports(db, threads, invalidate, notify);
  const agents = new TaskAgents(db, dataDir, threads);
  const board = new BoardJobs(db, agents, reports, invalidate, notify, log);
  const rules = new AutomationService(db, { agents, threads, board, sources, programs: { dataDir, values: new TriggerValues(options.automationSecrets) }, invalidate, notify, log });
  const team = new TeamColumnRuns({ db, account, threads, log });
  return {
    reports,
    board,
    rules,
    team,
    start() {
      rules.start();
      team.start();
    },
    stop() {
      rules.stop();
      team.stop();
    },
  };
}
