import type { Db } from "@openorc/db";
import type { Logger } from "../transport.js";
import { liveAutomationSources, type AutomationSources } from "./automation-sources.js";
import { AutomationService } from "./automations.js";
import { BoardJobs } from "./board-jobs.js";
import type { Notification } from "./run-types.js";
import { TaskAgents } from "./task-agents.js";
import { TaskReports } from "./task-reports.js";
import type { ThreadService } from "./threads.js";

/**
 * What the app does with tasks by itself: the updates agents post on them, the agents a board's columns start, and the
 * rules that wait for something to happen.
 */
export interface TaskAutomation {
  reports: TaskReports;
  board: BoardJobs;
  rules: AutomationService;
}

type Dependencies = {
  db: Db;
  dataDir: string;
  threads: ThreadService;
  /** Where the rules read what happened outside the app. GitHub and the project's own shell unless a test stands in. */
  sources?: AutomationSources | undefined;
  invalidate: (keys: string[]) => void;
  notify: (n: Omit<Notification, "type">) => void;
  log: Logger;
};

export function createTaskAutomation({ db, dataDir, threads, sources = liveAutomationSources, invalidate, notify, log }: Dependencies): TaskAutomation {
  const reports = new TaskReports(db, threads, invalidate, notify);
  const agents = new TaskAgents(db, dataDir, threads);
  const board = new BoardJobs(db, agents, reports, invalidate, notify, log);
  const rules = new AutomationService(db, { agents, threads, board, sources, invalidate, notify, log });
  return { reports, board, rules };
}
