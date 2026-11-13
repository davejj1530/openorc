import { randomUUID } from "node:crypto";
import type { CreateElicitationRequest, CreateElicitationResponse } from "@agentclientprotocol/sdk";
import type { AgentEvent, ApprovalDecision, ApprovalKind, ApprovalResolution } from "@openorc/protocol";
import { approvalAnswer, questionAnswer, questionInput, readElicitation, refinePlan, type Elicitation } from "./elicitation.js";

/** A request the agent waits on the person for; `cancel` answers it as cancelled, which a stopped turn needs. */
export type PendingRequest = { sessionId: string; cancel: () => void };

/** What a form becomes for OpenOrc to answer: an approval card or a question card. */
export interface FormApproval {
  runId: string;
  approvalId: string;
  kind: ApprovalKind;
  toolName: string;
  detail: string;
  input: unknown;
  onceOnly: boolean;
}

export interface FormRun {
  runId: string;
  /** The agent's product name, for a question with no words of its own. */
  agentName: string;
  /** The conversation is in Plan, where a proposed plan is shown rather than carried out. */
  planning: boolean;
  session: () => string | null;
  pending: Map<string, PendingRequest>;
  ask: (request: FormApproval) => Promise<ApprovalDecision | ApprovalResolution>;
  emit: (event: AgentEvent) => void;
  /** The whole proposed plan, where it can be read; the form itself holds only its first lines. */
  planText: () => Promise<string | null>;
  /** The plan was handed over: the turn that proposed it is stopped once this answer is on its way. */
  planShown: () => void;
}

/** The approval card's kind for an agent's own tool, by what the tool does. */
function kindOf(toolName: string): ApprovalKind {
  if (/^(bash|eval|python|js|sh|shell|ssh|debug)$/.test(toolName)) return "command";
  if (/^(write|edit|ast_edit|delete|move|notebook)$/.test(toolName)) return "file_change";
  return "tool";
}

/** The card a form becomes. */
function cardFor(elicited: Extract<Elicitation, { kind: "approval" | "question" }>, run: FormRun, approvalId: string): FormApproval {
  if (elicited.kind === "approval") {
    const input = elicited.detail.replace(/^Allow tool: .+\n?/, "").trim() || elicited.toolName;
    return { runId: run.runId, approvalId, kind: kindOf(elicited.toolName), toolName: elicited.toolName, detail: elicited.toolName, input: { input }, onceOnly: elicited.session === null };
  }
  const detail = elicited.questions.map((question) => question.question).join(" / ") || run.agentName;
  return { runId: run.runId, approvalId, kind: "user_input", toolName: "question", detail, input: questionInput(elicited), onceOnly: true };
}

/** The proposed plan, whole where it can be read, goes to OpenOrc in Plan; outside Plan the agent goes on as it asked. */
async function presentPlan(elicited: Extract<Elicitation, { kind: "plan" }>, run: FormRun): Promise<CreateElicitationResponse> {
  if (!run.planning) return { action: "accept", content: { value: "Approve and execute" } };
  const text = (await run.planText().catch(() => null)) ?? elicited.preview;
  if (text.trim()) run.emit({ type: "plan.updated", runId: run.runId, ts: Date.now(), documentId: "plan", text });
  run.planShown();
  return refinePlan;
}

/**
 * A form the agent asks the person to fill in: a question, an approval, or its plan for sign-off, answered with
 * OpenOrc's cards. One OpenOrc cannot show, or one for another session, is declined.
 */
export function answerForm(params: CreateElicitationRequest, run: FormRun): Promise<CreateElicitationResponse> {
  const named = (params as Record<string, unknown>)["sessionId"];
  const owner = typeof named === "string" ? named : run.session();
  const elicited = readElicitation(params);
  if (elicited.kind === "unsupported" || !owner || owner !== run.session()) return Promise.resolve({ action: "decline" });
  if (elicited.kind === "plan") return presentPlan(elicited, run);
  const approvalId = randomUUID();
  return new Promise<CreateElicitationResponse>((resolve) => {
    let settled = false;
    const respond = (response: CreateElicitationResponse) => {
      if (settled) return;
      settled = true;
      run.pending.delete(approvalId);
      resolve(response);
    };
    run.pending.set(approvalId, { sessionId: owner, cancel: () => respond({ action: "cancel" }) });
    void run.ask(cardFor(elicited, run, approvalId)).then(
      (answer) => {
        if (settled) return;
        const decision = typeof answer === "string" ? answer : answer.decision;
        const answers = typeof answer === "string" ? undefined : answer.answers;
        if (elicited.kind === "approval") respond(approvalAnswer(elicited, decision));
        else respond(decision === "deny" || !answers ? { action: "decline" } : questionAnswer(elicited, answers));
        run.emit({ type: "approval.resolved", runId: run.runId, ts: Date.now(), approvalId, decision, ...(answers ? { answers } : {}) });
      },
      () => respond({ action: "cancel" }),
    );
  });
}

/** Compactions the agent starts on its own, between turns too, which Oh My Pi reports outside the session's updates. */
export class AutoCompactions {
  private count = 0;
  active = false;

  constructor(
    private readonly runId: string,
    private readonly session: () => string | null,
    private readonly emit: (event: AgentEvent) => void,
  ) {}

  started(params: Record<string, unknown>): void {
    if (!this.session() || params["sessionId"] !== this.session()) return;
    this.active = true;
    this.count += 1;
    this.emit({ type: "activity.updated", runId: this.runId, ts: Date.now(), activityId: `auto-compaction-${this.count}`, label: "Compacting context", status: "running", detail: { mode: "auto" } });
  }

  ended(params: Record<string, unknown>): void {
    if (!this.session() || params["sessionId"] !== this.session()) return;
    this.active = false;
    const failed = typeof params["errorMessage"] === "string" && params["errorMessage"] ? params["errorMessage"] : null;
    const status = failed || params["aborted"] === true ? "error" : "success";
    this.emit({ type: "activity.updated", runId: this.runId, ts: Date.now(), activityId: `auto-compaction-${this.count}`, label: "Compacting context", status, ...(failed ? { text: failed } : {}) });
  }
}
