import { startMcpServer, type OpenOrcMcpServer } from "@openorc/mcp";
import type { OpenOrc } from "../openorc.js";
import type { OpenOrcOptions } from "../options.js";
import { guardContext } from "../remote/policy.js";
import { OnlineTaskTools } from "../services/online-task-tools.js";
import { createBrowserHost } from "./browser.js";
import { createContextHost } from "./context.js";
import { createDeviceHost } from "./device.js";
import { createMemoryHost } from "./memory.js";
import { createOrclingHost } from "./orcling.js";
import { createRunHost } from "./run.js";
import { createTaskCreateHost } from "./task-create.js";
import { createTasksHost } from "./tasks.js";
import { createThreadsHost } from "./threads.js";

/** What the core's tools for its agents are made from: its services, and the few things only the core itself holds. */
export type CoreTools = Pick<OpenOrc, "db" | "threads" | "runs" | "comments" | "refines" | "devices" | "memory" | "slack" | "orclings" | "settings" | "pullRequests"> & {
  /** Read each time, since the account comes and goes. */
  account: () => OpenOrc["account"];
  browser: OpenOrcOptions["browser"];
  dataDir: string;
  planLimits: Parameters<typeof createOrclingHost>[0]["planLimits"];
  call: (method: string, params: unknown) => Promise<unknown>;
  invalidate: (keys: string[]) => void;
};

/** The MCP server this Mac's agents reach the core through: every tool host, over one port. */
export function startCoreMcp(core: CoreTools): Promise<OpenOrcMcpServer> {
  const { assertRunAvailable, taskFor, projectFor } = createContextHost({ db: core.db });
  const threadsHost = createThreadsHost({ threadService: core.threads, db: core.db, assertRunAvailable });
  // A Mac agent's tools for its own project's tasks on OpenOrc Cloud, where the server opens them.
  const online = new OnlineTaskTools({
    account: core.account,
    projectFor: (runId) => {
      try {
        return projectFor(runId);
      } catch {
        return null;
      }
    },
    captureProcess: (runId) => core.runs.captureProcess(runId),
  });
  return startMcpServer({
    ...createRunHost({ runService: core.runs, db: core.db, comments: core.comments, refines: core.refines, assertRunAvailable }),
    ...createBrowserHost({ db: core.db, runService: core.runs, browser: core.browser, assertRunAvailable }),
    ...createDeviceHost({ db: core.db, runService: core.runs, devices: core.devices, assertRunAvailable }),
    ...createMemoryHost({ memoryService: core.memory, runService: core.runs, db: core.db, assertRunAvailable, taskFor, projectFor, online }),
    onlineTaskScopes: (runId) => online.scopes(runId),
    execution: {
      available: (runId) => core.slack.executionAvailable(runId),
      context: (runId) => core.slack.executionContext(runId),
      switch: (runId, input) => (input.orclingId ? core.slack.switchToOrcling(runId, input.orclingId, input.instructions) : core.slack.switchExecution(runId, input)),
    },
    ...threadsHost,
    ...createOrclingHost({
      db: core.db,
      orclings: core.orclings,
      memory: core.memory,
      runs: core.runs,
      threads: core.threads,
      settings: core.settings,
      send: threadsHost.threads.send,
      planLimits: () => core.planLimits(),
      guard: guardContext(core.db, core.dataDir),
      call: (method, params) => core.call(method, params),
      invalidate: (keys) => core.invalidate(keys),
    }),
    pullReview: core.pullRequests.agentTools(),
    tasks: {
      ...createTasksHost({ threadService: core.threads, dataDir: core.dataDir, assertRunAvailable, online }),
      create: createTaskCreateHost({ threadService: core.threads, assertRunAvailable, online }),
    },
  });
}
