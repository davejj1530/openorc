import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { core } from "../lib/rpc";
import { ApprovalCard } from "./ApprovalCard";
import { AnswersBlocked } from "./ask-answer";
import { QuestionCard } from "./QuestionCard";

vi.mock("../lib/rpc", () => ({
  core: new Proxy({ call: vi.fn() } as Record<string, unknown>, { get: (target, key: string) => (key in target ? target[key] : () => () => undefined) }),
}));
afterEach(() => {
  cleanup();
  vi.mocked(core.call).mockReset();
});

const approval = { id: "a", kind: "approval", approvalId: "ask-1", approvalKind: "command", toolName: "Bash", input: { command: "pnpm build" } } as never;
const question = { questions: [{ question: "Where should the export land?", options: [{ label: "Downloads folder" }, { label: "Ask each time" }] }] };
const wrap = (children: ReactNode, blocked: string | null = null) => <AnswersBlocked.Provider value={blocked}>{children}</AnswersBlocked.Provider>;

it("says on the approval card that its answer was refused", async () => {
  vi.mocked(core.call).mockRejectedValue(new Error("You're out of cloud hours."));
  render(wrap(<ApprovalCard block={approval} runId="hosted:cloud" />));
  fireEvent.click(screen.getByRole("button", { name: "Allow" }));
  await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("You're out of cloud hours."));
  expect(core.call).toHaveBeenCalledWith("approvals.resolve", { runId: "hosted:cloud", approvalId: "ask-1", decision: "allow" });
});

it("says on the question card that its answer was refused", async () => {
  vi.mocked(core.call).mockRejectedValue(new Error("Claude's sign-in on OpenOrc Cloud ended."));
  render(wrap(<QuestionCard runId="hosted:cloud" approvalId="ask-2" input={question} decided={undefined} />));
  fireEvent.click(screen.getByText("Ask each time"));
  fireEvent.click(screen.getByRole("button", { name: "Answer" }));
  await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Claude's sign-in on OpenOrc Cloud ended."));
});

it("takes no answer while the thread's place can't be reached, and says why on demand", () => {
  render(wrap(<ApprovalCard block={approval} runId="hosted:cloud" />, "OpenOrc Cloud can't be reached."));
  const allow = screen.getByRole("button", { name: "Allow" });
  expect(allow.hasAttribute("disabled")).toBe(true);
  expect(allow.getAttribute("data-tip")).toBe("OpenOrc Cloud can't be reached.");
  fireEvent.click(allow);
  expect(core.call).not.toHaveBeenCalled();
});
