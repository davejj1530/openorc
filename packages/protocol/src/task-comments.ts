import { z } from "zod";
import { HarnessId } from "./harness.js";
import type { ModelOption } from "./rpc.js";
import { harnessName, isHarnessId } from "./harness.js";
import { effortLabel, modelEfforts } from "./model-effort.js";
import { formatModelEffortLabel } from "./orchestration.js";

export const CommentRecipient = z.object({ agent: HarnessId, model: z.string().min(1), effort: z.string().nullable() }).strict();
export type CommentRecipient = z.infer<typeof CommentRecipient>;
export const CommentIntent = z.object({ intent: z.enum(["discussion", "clarification", "execution"]), quote: z.string().max(4000).default("") }).strict();
export type CommentIntent = z.infer<typeof CommentIntent>;
export type TaskComment = {
  id: string;
  taskId: string;
  requestKey: string;
  body: string;
  recipients: CommentRecipient[];
  replyTo: string | null;
  source: "comment" | "description";
  context: string;
  createdAt: number;
};
export type CommentAttemptState = "queued" | "running" | "success" | "error" | "cancelled" | "choose_executor" | "starting_work" | "working" | "completed";
export type CommentAttempt = {
  id: string;
  taskId: string;
  commentId: string;
  recipient: CommentRecipient;
  state: CommentAttemptState;
  body: string;
  error: string | null;
  runId: string | null;
  threadId: string | null;
  executionRunId: string | null;
  intent: CommentIntent | null;
  createdAt: number;
  updatedAt: number;
};
export type TaskDiscussion = {
  comments: TaskComment[];
  attempts: CommentAttempt[];
  questions?: { runId: string; approvalId: string; input: unknown }[];
  executionActivity?: Record<string, "idle" | "running" | "waiting">;
};
export const commentRecipientKey = (r: CommentRecipient): string => JSON.stringify([r.agent, r.model, r.effort]);
/** The exact form: harness, model ID and effort. Always accepted, but people see the name. */
export const commentMention = (r: CommentRecipient): string => `${r.agent}:${r.model}${r.effort ? `-${r.effort}` : ""}`;

export interface CommentMentionOption {
  /** What people read and type: the model's display name and effort, e.g. "Opus 5.5 - Max". */
  name: string;
  token: string;
  recipient: CommentRecipient;
}
type Candidate = CommentMentionOption & { provider: string };
/** What tells two options with the same name apart, in the order people look for it. */
const qualifiers: ((o: Candidate) => string)[] = [(o) => harnessName(o.recipient.agent), (o) => o.provider];

function groupByName<T extends { name: string }>(options: T[]): T[][] {
  const groups = new Map<string, T[]>();
  for (const o of options) {
    const key = o.name.toLowerCase();
    const group = groups.get(key);
    if (group) group.push(o);
    else groups.set(key, [o]);
  }
  return [...groups.values()];
}

/**
 * Every model and effort a comment can mention, by display name. Where two
 * would share a name, it adds the harness or provider that differs; any still
 * shared are named by their exact token.
 */
export function commentMentionOptions(models: ModelOption[]): CommentMentionOption[] {
  const options = models
    .filter((m) => isHarnessId(m.agent))
    .flatMap((m) => {
      const efforts = modelEfforts(m.agent, m.id, m.efforts);
      return (efforts.length ? efforts : [null]).map((effort): Candidate => {
        const recipient = { agent: m.agent as CommentRecipient["agent"], model: m.id, effort };
        return { name: formatModelEffortLabel(m.label, effort && effortLabel(effort)), token: commentMention(recipient), recipient, provider: m.provider?.label ?? "" };
      });
    });
  for (const group of groupByName(options)) {
    if (group.length < 2) continue;
    const differ = qualifiers.filter((qualifier) => new Set(group.map(qualifier)).size > 1);
    for (const o of group) {
      const qualified = differ.map((qualifier) => qualifier(o)).filter(Boolean);
      o.name = qualified.length ? `${o.name} (${qualified.join(" · ")})` : o.token;
    }
  }
  const shared = new Set(groupByName(options).flatMap((group) => (group.length > 1 ? group : [])));
  return options.map((o) => ({ name: shared.has(o) ? o.token : o.name, token: o.token, recipient: o.recipient }));
}

/** A mention ends at whitespace, closing punctuation or a sentence's final period. */
const mentionEnd = /^(?:$|[\s,;:!?)]|\.(?:\s|$))/;

/**
 * Who a comment asks, by display name or exact token, with or without the
 * harness. Names have several words and model IDs have hyphens, so the longest
 * whole match wins; nothing is split.
 */
export function resolveCommentMentions(text: string, models: ModelOption[]): CommentRecipient[] {
  const keys = commentMentionOptions(models).flatMap((o) => [o.name, o.token, o.token.slice(o.recipient.agent.length + 1)].map((key) => ({ key, recipient: o.recipient })));
  const result = new Map<string, CommentRecipient>();
  // Code blocks, inline code and quoted lines are inert examples.
  const prose = text
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`]*`/g, "")
    .replace(/^>.*$/gm, "");
  for (const match of prose.matchAll(/(?:^|\s)@(?=[^\s,;!?()<>])/g)) {
    const rest = prose.slice(match.index + match[0].length);
    const found = keys.filter(({ key }) => rest.slice(0, key.length).toLowerCase() === key.toLowerCase() && mentionEnd.test(rest.slice(key.length)));
    const longest = Math.max(0, ...found.map(({ key }) => key.length));
    const recipients = [...new Map(found.filter(({ key }) => key.length === longest).map(({ recipient }) => [commentRecipientKey(recipient), recipient])).values()];
    const word = /^[^\s,;!?()<>]+/.exec(rest)![0].replace(/[.]$/, "");
    if (recipients.length !== 1) throw new Error(recipients.length ? `Ambiguous @${word}. Choose a harness in autocomplete.` : `Unknown agent @${word}. Choose an available model and effort.`);
    const r = recipients[0]!;
    result.set(commentRecipientKey(r), r);
  }
  return [...result.values()];
}
