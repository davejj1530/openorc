import { z } from "zod";
import type { AgentEvent, ApprovalResolution } from "@openorc/protocol";
import type { AcpApprovalRequest } from "../acp/adapter.js";
import type { PiEvent, PiRpc } from "./rpc.js";

export type PiApproval = (request: AcpApprovalRequest) => Promise<ApprovalResolution>;
const toolRequest = z.object({ toolName: z.string(), toolCallId: z.string(), input: z.unknown() });
const uiRequest = z.object({ id: z.string(), method: z.string(), title: z.string().optional(), message: z.string().optional(), options: z.array(z.string()).optional() });
type UiRequest = z.infer<typeof uiRequest>;
type ToolRequest = z.infer<typeof toolRequest>;

function approval(runId: string, request: UiRequest, tool: ToolRequest | null): AcpApprovalRequest {
  let kind: AcpApprovalRequest["kind"] = tool ? "tool" : "user_input";
  if (tool?.toolName === "bash") kind = "command";
  if (tool && ["edit", "write"].includes(tool.toolName)) kind = "file_change";
  const options = request.options ?? (request.method === "confirm" ? ["Yes", "No"] : []);
  return {
    runId,
    approvalId: request.id,
    onceOnly: true,
    kind,
    toolName: tool?.toolName ?? "question",
    detail: tool?.toolName ?? request.title ?? "Pi has a question",
    input: tool?.input ?? { questions: [{ id: request.id, question: request.title ?? "Pi has a question", header: "Pi", options: options.map((label) => ({ label, description: label })) }] },
  };
}

function response(request: UiRequest, answer: ApprovalResolution, tool: boolean) {
  const value = answer.answers?.[request.id]?.[0];
  if (answer.decision === "deny") return { cancelled: true };
  if (request.method === "confirm") return { confirmed: tool || value === "Yes" };
  return { value: value ?? "" };
}

export class PiDialogs {
  private readonly requests = new Set<string>();
  ready = false;

  constructor(
    private readonly runId: string,
    private readonly nonce: string,
    private readonly rpc: PiRpc,
    private readonly ask: PiApproval,
    private readonly emit: (event: AgentEvent) => void,
  ) {}

  get pending(): boolean {
    return this.requests.size > 0;
  }

  async answer(event: PiEvent): Promise<void> {
    const request = uiRequest.parse(event);
    if (request.method === "notify" && request.message === `openorc-ready:${this.nonce}`) {
      this.ready = true;
      return;
    }
    if (!["confirm", "select", "input", "editor"].includes(request.method)) return;
    this.requests.add(request.id);
    try {
      const tool = request.title === `openorc-tool:${this.nonce}` ? toolRequest.parse(JSON.parse(request.message ?? "")) : null;
      const answer = await this.ask(approval(this.runId, request, tool));
      if (!this.requests.delete(request.id)) return;
      this.rpc.notify({ type: "extension_ui_response", id: request.id, ...response(request, answer, tool !== null) });
      this.emit({ type: "approval.resolved", runId: this.runId, ts: Date.now(), approvalId: request.id, decision: answer.decision });
    } catch {
      if (this.requests.delete(request.id)) this.rpc.notify({ type: "extension_ui_response", id: request.id, cancelled: true });
    }
  }

  cancel(): void {
    for (const id of this.requests) this.rpc.notify({ type: "extension_ui_response", id, cancelled: true });
    this.requests.clear();
  }
}
