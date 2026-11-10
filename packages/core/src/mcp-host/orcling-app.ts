import { audit, redactValue, runs, type Db } from "@openorc/db";
import type { OrclingTools } from "@openorc/mcp";
import { REMOTE_METHODS, rpcParams, type Orcling, type RemoteMethod, type RpcMethod, type RpcParams } from "@openorc/protocol";
import { z } from "zod";
import { admitRemoteRequest, type GuardContext } from "../remote/policy.js";
import type { RunService } from "../services/runs.js";

/**
 * What an Orcling may do in OpenOrc for the person: everything their paired phone may, under the guards the Mac's own
 * windows meet (an Orcling works on the Mac), and besides, the tasks they read and discuss and the pull requests they
 * review on the Mac: a review conversation started, its draft read and edited, and the review posted to GitHub. Each says whether it only reads or changes something, so a
 * method added to the phone's list does not compile here until it is placed.
 */
const ORCLING_EXTRAS = [
  "tasks.list",
  "tasks.comments.list",
  "tasks.comments.post",
  "pulls.list",
  "pulls.get",
  "pulls.diff",
  "pulls.review.get",
  "pulls.review.start",
  "pulls.review.comment",
  "pulls.review.editComment",
  "pulls.review.removeComment",
  "pulls.review.summary",
  "pulls.review.discard",
  "pulls.review.submit",
  "reviewerApp.get",
] as const satisfies readonly RpcMethod[];
type AppMethod = Exclude<RemoteMethod, "attachments.save"> | (typeof ORCLING_EXTRAS)[number];

const ACCESS: { [M in AppMethod]: "reads" | "changes" } = {
  "projects.list": "reads",
  "projects.get": "reads",
  "projects.git": "reads",
  "threads.list": "reads",
  "threads.resolvedCount": "reads",
  "threads.get": "reads",
  "threads.messages": "reads",
  "threads.lastMessage": "reads",
  "runs.listForThread": "reads",
  "events.page": "reads",
  "events.toolOutput": "reads",
  "inbox.list": "reads",
  "agents.models": "reads",
  "agents.availability": "reads",
  "skills.list": "reads",
  "claude.accounts.list": "reads",
  "providers.limits": "reads",
  "app.settings.get": "reads",
  "threads.start": "changes",
  "threads.update": "changes",
  "threads.switchClaudeAccount": "changes",
  "runs.start": "changes",
  "runs.send": "changes",
  "runs.interrupt": "changes",
  "subagents.stop": "changes",
  "threads.queue": "changes",
  "threads.unqueue": "changes",
  "threads.sendQueued": "changes",
  "approvals.resolve": "changes",
  "review.threadChanges": "reads",
  "review.threadFileDiff": "reads",
  "git.threadLog": "reads",
  "git.commitRange": "reads",
  "git.threadPushState": "reads",
  "review.threadPrTemplate": "reads",
  "pulls.branches": "reads",
  "system.gh": "reads",
  "review.commitThread": "changes",
  "review.pushThread": "changes",
  "review.createThreadPr": "changes",
  "preview.state": "reads",
  "tasks.get": "reads",
  "tasks.create": "changes",
  "tasks.update": "changes",
  "orclings.chats": "reads",
  "orclings.profile": "reads",
  "orclings.create": "changes",
  "orclings.update": "changes",
  "orclings.delete": "changes",
  "orclings.wakes.save": "changes",
  "orclings.instructions.save": "changes",
  "orclings.reactions": "reads",
  "orclings.react": "changes",
  "cloud.offer": "reads",
  "cloud.move": "changes",
  "threads.movePreview": "reads",
  "cloud.bringToMac": "changes",
  "cloud.keep": "changes",
  "cloud.sandboxes": "reads",
  "cloud.sandboxes.remove": "changes",
  "tasks.list": "reads",
  "tasks.comments.list": "reads",
  "tasks.comments.post": "changes",
  "pulls.list": "reads",
  "pulls.get": "reads",
  "pulls.diff": "reads",
  "pulls.review.get": "reads",
  "pulls.review.start": "changes",
  "pulls.review.comment": "changes",
  "pulls.review.editComment": "changes",
  "pulls.review.removeComment": "changes",
  "pulls.review.summary": "changes",
  "pulls.review.discard": "changes",
  "pulls.review.submit": "changes",
  "reviewerApp.get": "reads",
};
const isAppMethod = (method: string): method is AppMethod => Object.hasOwn(ACCESS, method);
const isRemote = (method: AppMethod): method is Exclude<AppMethod, (typeof ORCLING_EXTRAS)[number]> => (REMOTE_METHODS as readonly string[]).includes(method);

/** The most of a result the Orcling reads at once; a narrower call reads the rest. */
const RESULT_CHARS = 20_000;

export type AppDependencies = {
  db: Db;
  runs: Pick<RunService, "authorizeAppAction">;
  guard: GuardContext;
  /** One call into the core, answered as a window on the Mac is answered. */
  call: (method: string, params: unknown) => Promise<unknown>;
};

/**
 * What only the person decides about an Orcling, so it never decides it for itself: letting it work more freely (it may
 * choose to ask more), whether it exists, and what it asked them to allow.
 */
function selfRefusal(self: Orcling, db: Db, method: AppMethod, params: unknown): string | null {
  const p = params as Record<string, unknown>;
  if (method === "orclings.delete" && p["id"] === self.id) return "Only the person can delete you.";
  const raising = self.permission !== "allow" && (p["draft"] as { permission?: string } | undefined)?.permission === "allow";
  if (method === "orclings.update" && p["id"] === self.id && raising) return "Only the person can let you work without asking.";
  if (method === "approvals.resolve" && runs.get(db, String(p["runId"]))?.orclingId === self.id) return "Only the person can answer what you asked them.";
  return null;
}

function schemaOf(method: AppMethod): unknown {
  try {
    return z.toJSONSchema(rpcParams[method], { unrepresentable: "any" });
  } catch {
    return "Parameters could not be described; read errors for what is expected.";
  }
}

/** Anything the person can do in OpenOrc that an Orcling's other tools don't cover, as their phone would do it. */
export function appTools(deps: AppDependencies, speaker: (runId: string) => Orcling): Pick<OrclingTools, "appMethods" | "app"> {
  const { db } = deps;
  return {
    appMethods: async (runId, method) => {
      speaker(runId);
      if (method) {
        if (!isAppMethod(method)) return `${method} is not something you can do for the person. Call orcling_app_methods with no method for the list.`;
        return JSON.stringify({ method, [ACCESS[method]]: true, params: schemaOf(method) });
      }
      const names = Object.keys(ACCESS) as AppMethod[];
      return JSON.stringify({
        reads: names.filter((name) => ACCESS[name] === "reads"),
        changes: names.filter((name) => ACCESS[name] === "changes"),
        note: "Pass a method to see its parameters. Changes follow your permission; reads never ask.",
      });
    },
    app: async (runId, method, params) => {
      const self = speaker(runId);
      if (!isAppMethod(method)) throw new Error(`${method} is not something you can do for the person. orcling_app_methods lists what you can.`);
      const parsed = rpcParams[method].safeParse(params ?? {});
      if (!parsed.success) throw new Error(`${method} takes other parameters: ${parsed.error.message}`);
      const refusal = selfRefusal(self, db, method, parsed.data) ?? (isRemote(method) ? admitRemoteRequest(method, parsed.data, deps.guard, "owner") : { ok: true as const });
      if (typeof refusal === "string") throw new Error(refusal);
      if (!refusal.ok) throw new Error(refusal.message);
      if (ACCESS[method] === "changes") {
        await deps.runs.authorizeAppAction(runId, "person_action", { toolName: "orcling_app", reason: `${self.name} wants to ${method} for you.`, input: { method, params: parsed.data } });
        audit.record(db, { actor: "agent", action: "orcling.act", resourceType: "orcling", resourceId: self.id, metadata: { runId, method } });
      }
      const result = redactValue(await deps.call(method, parsed.data as RpcParams<typeof method>)).value;
      const text = JSON.stringify(result ?? null);
      return text.length > RESULT_CHARS ? `${text.slice(0, RESULT_CHARS)}… (cut at ${RESULT_CHARS} characters; narrow the call, such as a limit or an id, to read the rest)` : text;
    },
  };
}
