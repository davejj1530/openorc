import { describe, expect, it } from "vitest";
import type { CreateElicitationRequest } from "@agentclientprotocol/sdk";
import { approvalAnswer, questionAnswer, questionInput, readElicitation, type Elicitation } from "./elicitation.js";

const form = (message: string, properties: Record<string, unknown>, required?: string[]) =>
  ({ mode: "form", sessionId: "ses_1", message, requestedSchema: { type: "object", properties, ...(required ? { required } : {}) } }) as unknown as CreateElicitationRequest;

describe("form elicitations", () => {
  it("reads a plan sign-off with its title and the plan's first lines", () => {
    const read = readElicitation(
      form('Approve plan "add-readme" and start implementation?\n\n# Plan\n1. Write it', { value: { type: "string", enum: ["Approve and execute", "Refine plan"] } }, ["value"]),
    );
    expect(read).toEqual({ kind: "plan", title: "add-readme", preview: "# Plan\n1. Write it" });
  });

  it("reads an approval by its tool, a device's write by the device it names, and answers each decision with its choice", () => {
    const labels = ["Approve", "Approve write for this session", "Deny"];
    const read = readElicitation(form("Allow tool: write\nPath: src/a.ts\nContent:\nhi", { value: { type: "string", enum: labels } }, ["value"]));
    expect(read).toMatchObject({ kind: "approval", toolName: "write", once: "Approve", session: "Approve write for this session", deny: "Deny" });
    const approval = read as Extract<Elicitation, { kind: "approval" }>;
    expect(approvalAnswer(approval, "allow")).toEqual({ action: "accept", content: { value: "Approve" } });
    expect(approvalAnswer(approval, "allow_for_run")).toEqual({ action: "accept", content: { value: "Approve write for this session" } });
    expect(approvalAnswer(approval, "deny")).toEqual({ action: "accept", content: { value: "Deny" } });

    const device = readElicitation(form("Allow tool: write\nPath: xd://mcp__paper_search\nquery: x", { value: { type: "string", enum: ["Approve", "Deny"] } }));
    expect(device).toMatchObject({ kind: "approval", toolName: "mcp__paper_search", session: null });
    expect(approvalAnswer(device as Extract<Elicitation, { kind: "approval" }>, "allow_for_run")).toEqual({ action: "accept", content: { value: "Approve" } });
  });

  it("reads Oh My Pi's questions, single, multiple and typed, and fills the form back by question", () => {
    const read = readElicitation(
      form("Answer 2 questions", {
        q0: {
          type: "string",
          title: "Which color?",
          description: "Color",
          oneOf: [
            { const: "Red", title: "Red", description: "Warm" },
            { const: "Blue", title: "Blue" },
          ],
          default: "Blue",
        },
        q0__other: { type: "string", title: "Other (type your own)" },
        q1: {
          type: "array",
          title: "Which sizes?",
          items: {
            anyOf: [
              { const: "S", title: "S" },
              { const: "M", title: "M" },
            ],
          },
        },
      }),
    );
    expect(read.kind).toBe("question");
    const asked = read as Extract<Elicitation, { kind: "question" }>;
    expect(questionInput(asked)).toEqual({
      questions: [
        { id: "q0", question: "Which color?", header: "Color", options: [{ label: "Red", description: "Warm" }, { label: "Blue" }], allowOther: true },
        { id: "q1", question: "Which sizes?", options: [{ label: "S" }, { label: "M" }], multiSelect: true, allowOther: false },
      ],
    });
    expect(questionAnswer(asked, { q0: ["Blue"], q1: ["S", "M"] })).toEqual({ action: "accept", content: { q0: "Blue", q1: ["S", "M"] } });
    expect(questionAnswer(asked, { q0: ["Green, please"], q1: ["M"] })).toEqual({ action: "accept", content: { q0__other: "Green, please", q1: ["M"] } });
  });

  it("asks an extension's yes-or-no and free text as questions", () => {
    const confirm = readElicitation(form("Delete the cache?", { value: { type: "boolean" } }, ["value"])) as Extract<Elicitation, { kind: "question" }>;
    expect(questionInput(confirm).questions[0]).toMatchObject({ question: "Delete the cache?", options: [{ label: "Yes" }, { label: "No" }], allowOther: false });
    expect(questionAnswer(confirm, { value: ["No"] })).toEqual({ action: "accept", content: { value: false } });

    const typed = readElicitation(form("Name the branch", { value: { type: "string", description: "kebab-case" } }, ["value"])) as Extract<Elicitation, { kind: "question" }>;
    expect(questionInput(typed).questions[0]).toMatchObject({ question: "Name the branch", header: "kebab-case", allowOther: true });
    expect(questionAnswer(typed, { value: ["fix-login"] })).toEqual({ action: "accept", content: { value: "fix-login" } });
  });

  it("declines what it cannot show: a URL elicitation, or a form with fields it cannot ask", () => {
    expect(readElicitation({ mode: "url", sessionId: "ses_1", message: "Open", url: "https://x.example", elicitationId: "e" } as unknown as CreateElicitationRequest)).toEqual({ kind: "unsupported" });
    expect(readElicitation(form("Pick a number", { value: { type: "integer" } }))).toEqual({ kind: "unsupported" });
  });
});
