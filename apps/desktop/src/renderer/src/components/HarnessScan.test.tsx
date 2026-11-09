import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HarnessScan, type HarnessRow } from "./HarnessScan";

afterEach(cleanup);

const rows: HarnessRow[] = [
  {
    id: "claude",
    state: "ready",
    path: "/usr/local/bin/claude",
    version: "2.1.251",
    revision: 2,
  },
  {
    id: "codex",
    state: "sign_in",
    path: "/usr/local/bin/codex",
    version: "0.81.0",
    revision: 2,
  },
];

describe("HarnessScan", () => {
  it("lets compact rows toggle from the agent name while keeping sign-in actions separate", () => {
    const onChange = vi.fn();
    const onConnect = vi.fn();
    render(<HarnessScan rows={rows} compact selection={{ mode: "multiple", selectedIds: ["claude"], onChange }} onConnect={onConnect} />);
    fireEvent.click(screen.getByText("Claude Code"));
    expect(onChange).toHaveBeenCalledWith("claude");
    expect(screen.getByRole("checkbox", { name: "Claude Code selected" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByText("Connected with your existing sign-in.")).toBeNull();
    expect(screen.queryByText("Details")).toBeNull();
    expect(screen.queryByRole("checkbox", { name: /Codex/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Codex sign-in guide" }));
    expect(onConnect).toHaveBeenCalledWith("codex");
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("keeps sign-in actions visible while revealing optional installations on demand", () => {
    const onSetup = vi.fn();
    const missing: HarnessRow = { id: "opencode", state: "not_found", path: null, version: null, revision: 1 };
    render(<HarnessScan rows={[...rows, missing]} discloseUnavailable onSetup={onSetup} />);
    expect(screen.getByRole("button", { name: "Codex sign-in guide" })).toBeTruthy();
    const additionalAgents = screen.getByText("Add more agents").closest("details");
    expect(additionalAgents?.open).toBe(false);
    fireEvent.click(screen.getByText("Add more agents"));
    expect(additionalAgents?.open).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Install OpenCode" }));
    expect(onSetup).toHaveBeenCalledWith("opencode");
  });

  it("shows installation choices immediately when no agents are installed", () => {
    render(<HarnessScan rows={[{ ...rows[0]!, state: "not_found", path: null, version: null }]} discloseUnavailable />);
    expect(screen.getByRole("button", { name: "Install Claude Code" })).toBeTruthy();
    expect(screen.queryByText("Add more agents")).toBeNull();
  });

  it("keeps installation, authentication, and selection as distinct states", () => {
    const onChange = vi.fn();
    render(
      <HarnessScan
        rows={rows}
        selection={{
          mode: "multiple",
          selectedIds: ["claude"],
          onChange,
        }}
        onConnect={() => {}}
      />,
    );
    expect(screen.getByRole("img", { name: "Claude Code logo" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "Codex logo" })).toBeTruthy();
    expect(screen.getByText("Ready")).toBeTruthy();
    expect(screen.getByText("Sign-in needed")).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "Claude Code selected" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("checkbox", { name: "Claude Code selected" }));
    expect(onChange).toHaveBeenCalledWith("claude");
    expect(screen.getByRole("button", { name: "Codex sign-in guide" })).toBeTruthy();
    const details = screen.getAllByText("Details")[0]!.closest("details");
    expect(details?.open).toBe(false);
    fireEvent.click(screen.getAllByText("Details")[0]!);
    expect(details?.open).toBe(true);
  });

  it("does not erase the last result while a rescan is pending", () => {
    render(
      <HarnessScan
        rows={rows}
        selection={{
          mode: "multiple",
          selectedIds: ["claude"],
          onChange: () => {},
        }}
        refreshing
        onRefresh={() => {}}
      />,
    );
    expect(screen.getByText("Ready")).toBeTruthy();
    expect(screen.getByText("Sign-in needed")).toBeTruthy();
    expect(screen.getByText(/keeping the last results visible/i)).toBeTruthy();
    expect((screen.getByRole("button", { name: /rescanning/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("routes recovery actions by harness without making an unavailable row selectable", () => {
    const onRetry = vi.fn();
    const onSetup = vi.fn();
    const unavailable: HarnessRow[] = [
      {
        id: "claude",
        state: "check_failed",
        path: null,
        version: null,
        revision: 3,
      },
      {
        id: "codex",
        state: "not_found",
        path: null,
        version: null,
        revision: 3,
      },
    ];
    render(<HarnessScan rows={unavailable} onRetry={onRetry} onSetup={onSetup} />);
    fireEvent.click(screen.getByRole("button", { name: "Retry Claude Code check" }));
    fireEvent.click(screen.getByRole("button", { name: /install/i }));
    expect(onRetry).toHaveBeenCalledWith("claude");
    expect(onSetup).toHaveBeenCalledWith("codex");
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
  });

  it("uses radios only when choosing a default from selected ready agents", () => {
    const onChange = vi.fn();
    const readyRows: HarnessRow[] = [rows[0]!, { ...rows[1]!, state: "ready" }];
    render(
      <HarnessScan
        rows={readyRows}
        selection={{
          mode: "default",
          selectedId: "codex",
          onChange,
        }}
      />,
    );
    const claude = screen.getByRole("radio", {
      name: "Use Claude Code by default",
    });
    expect(claude.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByRole("radio", { name: "Use Codex by default" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(claude);
    expect(onChange).toHaveBeenCalledWith("claude");
  });
});
