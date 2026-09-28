import { z } from "zod";
import type { SlackJob } from "./relay.js";
export const RemoteApproval = z.object({ id: z.string().uuid(), text: z.string().min(1), canAllow: z.boolean() }).strict();
export type RemoteApproval = z.infer<typeof RemoteApproval>;
export type ApprovalPage = RemoteApproval & { part: number; parts: number };

/** Keep every character, including surrogate pairs, within Slack's section limit. */
export function approvalSections(text: string): string[] {
  const sections: string[] = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + 2800, text.length);
    const last = text.charCodeAt(end - 1);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--;
    sections.push(text.slice(start, end));
    start = end;
  }
  return sections;
}
export const RemoteDecision = z.object({ id: z.string().uuid(), decision: z.enum(["allow", "deny"]) }).strict();
export type RemoteDecision = z.infer<typeof RemoteDecision>;
export const ApprovalSync = z.object({ jobId: z.string(), requests: z.array(RemoteApproval).max(20) }).strict();
const Action = z.object({
  type: z.literal("block_actions"),
  team: z.object({ id: z.string() }),
  user: z.object({ id: z.string() }),
  container: z.object({ channel_id: z.string(), message_ts: z.string() }),
  actions: z.array(z.object({ action_id: z.enum(["openorc_allow", "openorc_deny"]), value: z.string().uuid() })).length(1),
});
type Record = { request: RemoteApproval; job: SlackJob; message: string | null; expires: number; page: number; posting?: Promise<void>; decision?: RemoteDecision; closed?: boolean };

/** Volatile capabilities: a relay restart invalidates every old button. The
 * desktop remains authoritative and rechecks the live approval before applying. */
export class SlackApprovals {
  private readonly records = new Map<string, Record>();
  constructor(
    private readonly post: (job: SlackJob, request: ApprovalPage) => Promise<string>,
    private readonly update: (job: SlackJob, ts: string, text: string) => Promise<void>,
  ) {}
  async sync(job: SlackJob, requests: RemoteApproval[]): Promise<RemoteDecision[]> {
    const active = new Set(requests.map((r) => r.id));
    for (const [id, record] of this.records) {
      if (record.job.id !== job.id) continue;
      if (!active.has(id)) {
        record.closed = true;
        this.records.delete(id);
        // Retire the capability even if its Slack message was deleted or can no longer be updated.
        if (record.message) await this.update(record.job, record.message, "This request is no longer pending on your desktop.").catch(() => {});
      }
    }
    const decisions: RemoteDecision[] = [];
    for (const request of requests) {
      let record = this.records.get(request.id);
      if (!record) {
        record = { request, job, message: null, expires: Date.now() + 10 * 60_000, page: 0 };
        this.records.set(request.id, record);
      }
      if (record.job.id !== job.id || record.job.userId !== job.userId) throw new Error("Approval owner changed");
      if (record.request.text !== request.text || record.request.canAllow !== request.canAllow) throw new Error("Approval details changed");
      if (!record.message && !record.closed) {
        // Four sections per message stay well below message and block limits.
        // Resume partial delivery, and share in-flight sends across HTTP retries.
        record.posting ??= this.publish(record).finally(() => {
          record!.posting = undefined;
        });
        await record.posting;
      }
      if (record.decision && !record.closed) decisions.push(record.decision);
    }
    return decisions;
  }
  private async publish(record: Record): Promise<void> {
    const sections = approvalSections(record.request.text);
    const parts = Math.ceil(sections.length / 4);
    while (record.page < parts && !record.closed) {
      const message = await this.post(record.job, { ...record.request, text: sections.slice(record.page * 4, (record.page + 1) * 4).join(""), part: record.page + 1, parts });
      record.page++;
      // Only the last message has decision buttons, after all details are delivered.
      if (record.page === parts) record.message = message;
    }
  }
  act(raw: unknown): boolean {
    const parsed = Action.safeParse(raw);
    if (!parsed.success) return false;
    const body = parsed.data,
      action = body.actions[0]!;
    const record = this.records.get(action.value);
    if (!record || record.closed || record.decision || Date.now() > record.expires || !record.message) return false;
    if (body.team.id !== record.job.workspaceId || body.user.id !== record.job.userId || body.container.channel_id !== record.job.channelId || body.container.message_ts !== record.message)
      return false;
    const decision = action.action_id === "openorc_allow" ? "allow" : "deny";
    if (decision === "allow" && !record.request.canAllow) return false;
    record.decision = { id: action.value, decision };
    return true;
  }
  revoke(jobId: string): void {
    for (const record of this.records.values()) if (record.job.id === jobId) record.closed = true;
  }
}
