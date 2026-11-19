import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef, useState, type ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HOSTED_REASONS, type HostedCapabilities } from "@openorc/protocol";
import { queryClient } from "../lib/client";
import { core } from "../lib/rpc";
import { Composer, type ComposerProps } from "./Composer";
import { ComposerAddMenu } from "./ComposerAddMenu";
import { ComposerCommitChip } from "./ComposerCommitChip";
import { ContextUsage } from "./ContextUsage";
import { HostedConversationBoundary } from "./HostedConversationBoundary";
import { ModelPickerRail } from "./ModelPickerRail";
import { TipLayer } from "./TipLayer";
import { PickerAccountRows } from "./ModelPickerAccounts";
import { cloudReviewThread } from "./test-fixtures/hosted-review";
import { messageOf, press, type } from "./composer-editor/testing";

/** What the cloud thread's server serves: nothing by default, as a server from before Compact. */
let served: HostedCapabilities["features"] = {};
beforeEach(() => {
  queryClient.clear();
  served = {};
  vi.spyOn(core, "call").mockImplementation(async (method: string) => {
    if (method === "hosted.capabilities") return { version: 1, features: served };
    throw new Error("Unexpected read");
  });
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.restoreAllMocks();
});
const mount = (children: ReactNode) =>
  render(
    <QueryClientProvider client={queryClient}>
      <HostedConversationBoundary thread={cloudReviewThread}>{children}</HostedConversationBoundary>
    </QueryClientProvider>,
  );

it("shows real context while disabling manual compaction with a focusable reason", async () => {
  const compact = vi.fn();
  mount(<ContextUsage used={1500} window={10000} onCompact={compact} />);
  fireEvent.click(screen.getByRole("button", { name: "Context usage" }));
  expect(await screen.findByText("1,500 tokens")).toBeTruthy();
  const button = screen.getByRole("button", { name: "Compact context" });
  expect(button.hasAttribute("disabled")).toBe(true);
  await act(async () => screen.getByLabelText("Compact context").focus());
  expect(await screen.findByText(HOSTED_REASONS.compact)).toBeTruthy();
  fireEvent.click(button);
  expect(compact).not.toHaveBeenCalled();
});

it("offers Compact context once the cloud thread's server serves it", async () => {
  served = { compact: { available: true } };
  const compact = vi.fn();
  mount(<ContextUsage used={1500} window={10000} onCompact={compact} />);
  fireEvent.click(screen.getByRole("button", { name: "Context usage" }));
  await vi.waitFor(() => expect(screen.getByRole("button", { name: "Compact context" }).hasAttribute("disabled")).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "Compact context" }));
  expect(compact).toHaveBeenCalledOnce();
});

it("runs /compact as the app's command once the server serves it, while /fork keeps its reason", async () => {
  served = { compact: { available: true } };
  const submit = vi.fn(async () => {});
  const compact = vi.fn();
  mount(<Draft onSubmit={submit} commands={[{ name: "compact", hint: "Summarize", run: compact }]} />);
  const field = screen.getByRole("textbox", { name: "Message" });
  await act(async () => {});
  type(field, "/", 1);
  expect(await screen.findByRole("option", { name: "/compact Summarize" })).toBeTruthy();
  expect(screen.getByRole("option", { name: "/fork" }).getAttribute("aria-disabled")).toBe("true");
  // In the Mac's order: compact, then fork.
  expect(screen.getAllByRole("option").map((option) => option.textContent?.split(" ")[0]?.slice(0, 8))).toEqual(["/compact", "/fork"]);
  type(field, "/compact", 8);
  press(field, { key: "Enter" });
  await vi.waitFor(() => expect(compact).toHaveBeenCalledOnce());
  expect(submit).not.toHaveBeenCalled();
});

it("keeps project file mentions disabled without disabling uploads", async () => {
  mount(<ComposerAddMenu onFiles={vi.fn()} offers={{ files: true, orclings: false, skills: false, connectors: false, commands: false, written: false }} lists={createRef()} />);
  fireEvent.click(screen.getByRole("button", { name: "Add to this message" }));
  const item = await screen.findByRole("menuitem", { name: "File from the project" });
  expect(item.getAttribute("aria-disabled")).toBe("true");
  await act(async () => item.focus());
  expect(await screen.findByText(HOSTED_REASONS.fileBrowser)).toBeTruthy();
  expect(screen.getByRole("menuitem", { name: "Files…" }).getAttribute("aria-disabled")).not.toBe("true");
});

it("keeps a shown Fast setting disabled with its specific reason", async () => {
  const toggle = vi.fn();
  mount(
    <ModelPickerRail
      section="codex"
      onSectionChange={vi.fn()}
      enabled={["codex"]}
      orclings={false}
      system={undefined}
      fast={{ active: false, blocked: false, hint: "Fast", disabled: false, onToggle: toggle }}
    />,
  );
  const button = screen.getByRole("button", { name: "Fast mode" });
  expect(button.hasAttribute("disabled")).toBe(true);
  await act(async () => button.parentElement?.focus());
  expect(await screen.findByText(HOSTED_REASONS.speed)).toBeTruthy();
  fireEvent.click(button);
  expect(toggle).not.toHaveBeenCalled();
});

it("does not read or offer another local Claude account for a cloud turn", async () => {
  const choose = vi.fn();
  mount(<PickerAccountRows section="claude" searching={false} accounts={{ current: "local", accounts: [{ id: "local", name: "Local account", status: "ready" }], choose }} moveRowFocus={() => {}} />);
  const account = await screen.findByRole("button", { name: "Claude account" });
  expect(account.hasAttribute("disabled")).toBe(true);
  await act(async () => account.parentElement?.focus());
  expect(await screen.findByText(HOSTED_REASONS.claudeAccount)).toBeTruthy();
  expect(
    vi
      .mocked(core.call)
      .mock.calls.map(([method]) => method)
      .filter((method) => method !== "hosted.capabilities"),
  ).toEqual([]);
});

it("offers a cloud turn the person's cloud accounts in its agent's section, with each one's cloud usage", async () => {
  const choose = vi.fn();
  vi.mocked(core.call).mockImplementation((async (method: string) =>
    method === "providers.usage"
      ? { status: "available", windows: [{ id: "seven_day", label: "Weekly", usedPercent: 40, remainingPercent: 60 }], credits: [] }
      : { version: 1, features: served }) as never);
  const accounts = {
    cloud: true as const,
    section: "codex",
    current: "pro",
    accounts: [
      { id: "pro", name: "ChatGPT Pro", status: "ready" as const },
      { id: "team", name: "Team", status: "ready" as const },
    ],
    choose,
    usage: (id: string) => ({ provider: "codex" as const, cloud: true as const, cloudAccountId: id }),
  };
  mount(<PickerAccountRows section="codex" searching={false} accounts={accounts} moveRowFocus={() => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: /Team/ }));
  expect(choose).toHaveBeenCalledWith("team");
  expect(await screen.findAllByText("60% wk")).toHaveLength(2);
  expect(vi.mocked(core.call)).toHaveBeenCalledWith("providers.usage", { provider: "codex", cloud: true, cloudAccountId: "team" });
});

const base: ComposerProps = {
  value: "",
  onChange: vi.fn(),
  onSubmit: async () => {},
  placeholder: "Message",
  model: null,
  onModel: vi.fn(),
  mode: "act",
  onMode: vi.fn(),
  permission: "trusted",
  onPermission: vi.fn(),
  location: { label: null, branch: null },
};
function Draft(props: Partial<ComposerProps>) {
  const [value, onChange] = useState("");
  return <Composer {...base} {...props} value={value} onChange={onChange} />;
}
it("does not read this Mac's files when a cloud message types a file mention", async () => {
  mount(<Draft fileSearch={{ kind: "thread", id: cloudReviewThread.id }} />);
  type(screen.getByRole("textbox", { name: "Message" }), "@example", 8);
  await act(async () => {});
  expect(vi.mocked(core.call).mock.calls.some(([method]) => method === "files.search")).toBe(false);
});

it("does not execute or send a disabled cloud slash command", async () => {
  const submit = vi.fn(async () => {});
  const compact = vi.fn();
  mount(<Draft onSubmit={submit} commands={[{ name: "compact", hint: "Summarize", run: compact }]} />);
  const field = screen.getByRole("textbox", { name: "Message" });
  type(field, "/compact", 8);
  press(field, { key: "Enter" });
  expect(messageOf(field)).toBe("/compact");
  expect(compact).not.toHaveBeenCalled();
  expect(submit).not.toHaveBeenCalled();
});

it("lets the keyboard reach each unavailable cloud command's reason", async () => {
  mount(<Draft />);
  const field = screen.getByRole("textbox", { name: "Message" });
  type(field, "/", 1);
  press(field, { key: "ArrowDown" });
  expect(await screen.findByText(HOSTED_REASONS.fork)).toBeTruthy();
  press(field, { key: "ArrowUp" });
  expect(await screen.findByText(HOSTED_REASONS.compact)).toBeTruthy();
  expect(messageOf(field)).toBe("/");
});
it("says each unavailable cloud command's reason on hover, in the window's tip", async () => {
  mount(
    <>
      <Draft />
      <TipLayer />
    </>,
  );
  const field = screen.getByRole("textbox", { name: "Message" });
  type(field, "/", 1);
  for (const [name, reason] of [
    ["/compact", HOSTED_REASONS.compact],
    ["/fork", HOSTED_REASONS.fork],
  ] as const) {
    const row = screen.getByRole("option", { name });
    expect(row.getAttribute("aria-disabled")).toBe("true");
    fireEvent.mouseOver(row);
    expect(await screen.findByText(reason, {}, { timeout: 2_000 })).toBeTruthy();
    fireEvent.mouseOut(row);
  }
});

it("leaves unknown context out of the cloud composer", () => {
  mount(<Draft />);
  expect(screen.queryByRole("button", { name: "Context" })).toBeNull();
  expect(screen.queryByLabelText("Context usage")).toBeNull();
  expect(screen.queryByText("0%")).toBeNull();
});

it("offers only Commit when the cloud has no uncommitted totals", () => {
  const commit = vi.fn();
  mount(<ComposerCommitChip changes={{ uncounted: true, files: 0, insertions: 0, deletions: 0, inPanel: false, projectName: "Example", onCommit: commit, onReview: vi.fn(), onRetry: vi.fn() }} />);
  expect(screen.getByRole("region", { name: "Uncommitted changes" }).textContent).toBe("Commit");
  fireEvent.click(screen.getByRole("button", { name: "Commit changes" }));
  expect(commit).toHaveBeenCalledOnce();
});
