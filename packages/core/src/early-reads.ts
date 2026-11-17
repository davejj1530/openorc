import { ownerRoute, type RpcMethod, type RpcParams, type RpcRequest } from "@openorc/protocol";
import { projects, runs, threads, type Db } from "@openorc/db";

/**
 * What a start answers before the login shell has (`OpenOrc.open`): reads of this Mac's ledger and settings that start
 * no process and say nothing the account, the cloud or the agents' environment decides. A list answers with this Mac's
 * rows, and OpenOrc Cloud's join it once the account is heard, as they do today. A read about one thread or run answers
 * early, as a project does, only when this Mac's ledger holds it: one OpenOrc Cloud holds waits, since only the account
 * can answer it.
 * Every other call waits for the start, as every call did before.
 */
const LEDGER_READS: ReadonlySet<RpcMethod> = new Set<RpcMethod>([
  "threads.list",
  "threads.get",
  "runs.listForThread",
  "threads.messages",
  "threads.plans",
  "threads.checkpoints",
  "events.page",
  "events.listForRun",
  "projects.list",
  "projects.get",
  "tasks.list",
  "orclings.list",
  "orclings.groups.list",
  "app.settings.get",
]);

export function answeredEarly(db: Db, request: RpcRequest): boolean {
  const method = request.method as RpcMethod;
  if (!LEDGER_READS.has(method)) return false;
  if (method === "projects.get") {
    const id = (request.params as { id?: unknown } | undefined)?.id;
    return typeof id === "string" && projects.get(db, id) !== null;
  }
  const route = ownerRoute(method);
  if (!route || route.by === "merge" || route.by === "here" || route.by === "start" || route.by === "task") return true;
  const params = (request.params ?? {}) as RpcParams<typeof method>;
  if (route.by === "run") {
    const runId = route.run(params as never);
    return typeof runId === "string" && runs.get(db, runId) !== null;
  }
  const threadId = route.thread(params as never);
  return typeof threadId === "string" && threads.get(db, threadId) !== null;
}
