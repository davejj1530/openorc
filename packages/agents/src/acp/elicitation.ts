import type { CreateElicitationRequest, CreateElicitationResponse, ElicitationContentValue } from "@agentclientprotocol/sdk";
import type { ApprovalDecision } from "@openorc/protocol";

/** One question as OpenOrc's question card reads it, with where its answer goes back. */
export interface ElicitedQuestion {
  id: string;
  question: string;
  header?: string;
  options?: { label: string; description?: string }[];
  multiSelect?: boolean;
  allowOther: boolean;
  /** The field a typed answer goes in, when the form has one beside the choices. */
  other: string | null;
  /** A yes-or-no field, asked as two choices. */
  boolean: boolean;
}

/**
 * What a form elicitation asks for, in OpenOrc's terms. Oh My Pi asks its questions, its approvals beyond commands
 * and its plan sign-off this way; anything else that fits the form becomes a question.
 */
export type Elicitation =
  | { kind: "plan"; title: string | null; preview: string }
  | { kind: "approval"; toolName: string; detail: string; once: string; session: string | null; deny: string }
  | { kind: "question"; message: string; questions: ElicitedQuestion[] }
  | { kind: "unsupported" };

const PLAN_APPROVE = "Approve and execute";
const PLAN_REFINE = "Refine plan";

type Property = Record<string, unknown>;
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value : null);

/** The labelled choices a field offers: `enum`, or `oneOf`/`anyOf` entries with `const` and `title`. */
function choices(property: Property): { label: string; description?: string }[] | null {
  if (Array.isArray(property["enum"])) return property["enum"].filter((value): value is string => typeof value === "string").map((label) => ({ label }));
  const listed = property["oneOf"] ?? property["anyOf"];
  if (!Array.isArray(listed)) return null;
  return listed.filter(isRecord).flatMap((entry) => {
    const label = text(entry["const"]) ?? text(entry["title"]);
    const description = text(entry["description"]);
    return label ? [{ label, ...(description ? { description } : {}) }] : [];
  });
}

/** One field as a question: choices from the field or, for a list, its items; a yes-or-no field as two choices. */
function questionOf(id: string, property: Property, fallback: string, other: string | null): ElicitedQuestion | null {
  const question = text(property["title"]) ?? fallback;
  const header = text(property["description"]) ?? undefined;
  const base = { id, question, ...(header ? { header: header.slice(0, 100) } : {}), other };
  if (property["type"] === "boolean") return { ...base, options: [{ label: "Yes" }, { label: "No" }], allowOther: false, boolean: true };
  if (property["type"] === "array") {
    const items = isRecord(property["items"]) ? choices(property["items"]) : null;
    if (!items?.length) return null;
    return { ...base, options: items, multiSelect: true, allowOther: other !== null, boolean: false };
  }
  if (property["type"] !== "string") return null;
  const listed = choices(property);
  if (listed?.length) return { ...base, options: listed, allowOther: other !== null, boolean: false };
  return { ...base, allowOther: true, boolean: false };
}

/** The plan sign-off Oh My Pi asks for, with its title and the plan's first lines. */
function readPlan(message: string, labels: string[]): Elicitation | null {
  if (!labels.includes(PLAN_APPROVE) || !labels.includes(PLAN_REFINE)) return null;
  const title = /^Approve plan "(.*)" and start implementation\?/.exec(message)?.[1] ?? null;
  return { kind: "plan", title, preview: message.split("\n\n").slice(1).join("\n\n").trim() };
}

/** An approval of one tool, `Allow tool: <name>` with an approve and a deny choice. */
function readApproval(message: string, labels: string[]): Elicitation | null {
  const allow = /^Allow tool: (.+)$/m.exec(message)?.[1]?.trim();
  const once = labels.find((label) => label === "Approve" || label === "Approve Once");
  if (!allow || !once || !labels.includes("Deny")) return null;
  // A tool mounted as an xd:// device is approved as a write to its device; the device names the tool.
  const device = allow === "write" ? /^Path: xd:\/\/([A-Za-z0-9_.-]+)/m.exec(message)?.[1] : undefined;
  const session = labels.find((label) => label.startsWith("Approve ") && label.endsWith(" for this session")) ?? null;
  return { kind: "approval", toolName: device ?? allow, detail: message, once, session, deny: "Deny" };
}

/** Every field as a question, a typed answer's field beside the one it answers; unsupported when any cannot be asked. */
function readQuestions(message: string, properties: Record<string, Property>): Elicitation {
  const questions: ElicitedQuestion[] = [];
  for (const key of Object.keys(properties).filter((name) => !name.endsWith("__other"))) {
    const other = isRecord(properties[`${key}__other`]) ? `${key}__other` : null;
    const question = questionOf(key, properties[key]!, message || "Your answer", other);
    if (!question) return { kind: "unsupported" };
    questions.push(question);
  }
  return questions.length && questions.length <= 10 ? { kind: "question", message, questions } : { kind: "unsupported" };
}

/** Reads what a form elicitation asks. A URL elicitation, or a form OpenOrc cannot show, is unsupported. */
export function readElicitation(request: CreateElicitationRequest): Elicitation {
  const raw = request as Record<string, unknown>;
  const schema = isRecord(raw["requestedSchema"]) ? raw["requestedSchema"] : null;
  const properties = schema && isRecord(schema["properties"]) ? (schema["properties"] as Record<string, Property>) : null;
  if (raw["mode"] !== "form" || !properties) return { kind: "unsupported" };
  const message = typeof request.message === "string" ? request.message : "";
  const value = isRecord(properties["value"]) ? properties["value"] : null;
  const labels = value ? (choices(value) ?? []).map((choice) => choice.label) : [];
  return readPlan(message, labels) ?? readApproval(message, labels) ?? readQuestions(message, properties);
}

/** The plan sign-off answer that keeps the agent planning: OpenOrc shows the plan and the person decides there. */
export const refinePlan: CreateElicitationResponse = { action: "accept", content: { value: PLAN_REFINE } };

/** The approval answer for a decision; a denial, or a decision the form has no choice for, picks Deny. */
export function approvalAnswer(elicited: Extract<Elicitation, { kind: "approval" }>, decision: ApprovalDecision): CreateElicitationResponse {
  let value = elicited.deny;
  if (decision === "allow") value = elicited.once;
  else if (decision === "allow_for_run") value = elicited.session ?? elicited.once;
  return { action: "accept", content: { value } };
}

/** The form filled in from the card's answers, each by its question's id; a typed answer goes in the field for one. */
export function questionAnswer(elicited: Extract<Elicitation, { kind: "question" }>, answers: Record<string, string[]>): CreateElicitationResponse {
  const content: Record<string, ElicitationContentValue> = {};
  for (const question of elicited.questions) {
    const given = answers[question.id] ?? [];
    if (!given.length) continue;
    if (question.boolean) {
      content[question.id] = given[0] === "Yes";
      continue;
    }
    const known = new Set((question.options ?? []).map((option) => option.label));
    const picked = question.options ? given.filter((answer) => known.has(answer)) : given;
    const typed = question.options ? given.filter((answer) => !known.has(answer)) : [];
    if (question.multiSelect) content[question.id] = picked;
    else if (picked[0] !== undefined) content[question.id] = picked[0];
    if (typed.length) {
      if (question.other) content[question.other] = typed.join("\n");
      else if (!question.multiSelect && picked[0] === undefined) content[question.id] = typed[0]!;
    }
  }
  return { action: "accept", content };
}

/** The card's input for a question form, as OpenOrc's question cards read it. */
export function questionInput(elicited: Extract<Elicitation, { kind: "question" }>): { questions: Record<string, unknown>[] } {
  return {
    questions: elicited.questions.map(({ id, question, header, options, multiSelect, allowOther }) => ({
      id,
      question,
      ...(header ? { header } : {}),
      ...(options ? { options } : {}),
      ...(multiSelect ? { multiSelect } : {}),
      allowOther,
    })),
  };
}
