import { harnessCatalog, type HarnessId, type HarnessInfo } from "@openorc/protocol";
import { harnessLogos } from "./HarnessLogo";
import { AlertCircle, Check, ChevronDown, ExternalLink, Loader2, RefreshCw } from "./icons";
import { Badge, Button, TextButton } from "./ui";
import { cn } from "../lib/cn";
import type { ReactNode } from "react";

export type HarnessRowState = HarnessInfo["state"] | "checking";

export interface HarnessRow extends Omit<HarnessInfo, "state"> {
  state: HarnessRowState;
}

interface HarnessScanProps {
  rows: readonly HarnessRow[];
  selection?:
    | Readonly<{
        mode: "multiple";
        selectedIds: readonly HarnessId[];
        onChange: (id: HarnessId) => void;
      }>
    | Readonly<{
        mode: "default";
        selectedId: HarnessId | null;
        onChange: (id: HarnessId) => void;
      }>;
  onRefresh?: () => void;
  onRetry?: (id: HarnessId) => void;
  onConnect?: (id: HarnessId) => void;
  onSetup?: (id: HarnessId) => void;
  refreshing?: boolean;
  className?: string;
}

const stateLabels: Record<HarnessRowState, string> = {
  checking: "Checking",
  ready: "Ready",
  sign_in: "Sign-in needed",
  not_found: "Not installed",
  check_failed: "Couldn't check",
};

const stateGuidance: Record<HarnessRowState, string> = {
  checking: "Looking for an installation and an existing sign-in…",
  ready: "Connected with your existing sign-in.",
  sign_in: "Sign in using the agent’s setup guide, then rescan.",
  not_found: "Install this agent, then rescan. You only need one to get started.",
  check_failed: "The check didn’t finish. Retry to confirm this agent’s status.",
};

function tone(state: HarnessRowState): "muted" | "ok" | "warn" | "bad" {
  if (state === "ready") return "ok";
  if (state === "sign_in") return "warn";
  if (state === "check_failed") return "bad";
  return "muted";
}

function StatusBadge({ state }: { state: HarnessRowState }) {
  let icon: ReactNode = null;
  if (state === "checking") icon = <Loader2 className="onboarding-spin" size={11} />;
  else if (state === "check_failed") icon = <AlertCircle size={11} />;
  return (
    <Badge tone={tone(state)}>
      {icon}
      {stateLabels[state]}
    </Badge>
  );
}

function RowAction({
  row,
  selection,
  onRetry,
  onConnect,
  onSetup,
}: {
  row: HarnessRow;
  selection?: HarnessScanProps["selection"];
  onRetry?: (id: HarnessId) => void;
  onConnect?: (id: HarnessId) => void;
  onSetup?: (id: HarnessId) => void;
}) {
  if (row.state === "ready" && selection?.mode === "multiple") {
    const selected = selection.selectedIds.includes(row.id);
    return (
      <button
        type="button"
        role="checkbox"
        aria-checked={selected}
        aria-label={`${harnessCatalog[row.id].name} ${selected ? "selected" : "not selected"}`}
        className="harness-choice"
        data-selection-mode="multiple"
        onClick={() => selection.onChange(row.id)}
      >
        <span className="harness-choice-mark" aria-hidden="true">
          {selected ? <Check size={13} /> : null}
        </span>
        {selected ? "Selected" : "Select"}
      </button>
    );
  }
  if (row.state === "ready" && selection?.mode === "default") {
    const selected = selection.selectedId === row.id;
    return (
      <button
        type="button"
        role="radio"
        aria-checked={selected}
        aria-label={`Use ${harnessCatalog[row.id].name} by default`}
        className="harness-choice"
        data-selection-mode="default"
        onClick={() => selection.onChange(row.id)}
      >
        <span className="harness-choice-mark" aria-hidden="true">
          {selected ? <Check size={13} /> : null}
        </span>
        {selected ? "Default" : "Make default"}
      </button>
    );
  }
  if (row.state === "sign_in") {
    return (
      <Button aria-label={`${harnessCatalog[row.id].name} sign-in guide`} onClick={() => onConnect?.(row.id)}>
        Sign-in guide <ExternalLink size={13} />
      </Button>
    );
  }
  if (row.state === "not_found") {
    return (
      <Button aria-label={`Install ${harnessCatalog[row.id].name}`} onClick={() => onSetup?.(row.id)}>
        Install <ExternalLink size={13} />
      </Button>
    );
  }
  if (row.state === "check_failed") {
    return (
      <Button aria-label={`Retry ${harnessCatalog[row.id].name} check`} onClick={() => onRetry?.(row.id)}>
        Retry
      </Button>
    );
  }
  return null;
}

/**
 * The shared harness capability list. Onboarding, recovery, and Settings pass
 * the same normalized rows so a green Ready state always carries one meaning.
 */
export function HarnessScan({ rows, onRefresh, onRetry, onConnect, onSetup, refreshing = false, selection, className }: HarnessScanProps) {
  let selectionLabel = "Coding agent availability";
  if (selection?.mode === "default") selectionLabel = "Default coding agent";
  else if (selection?.mode === "multiple") selectionLabel = "Selected coding agents";
  return (
    <section className={cn("harness-scan", className)} aria-labelledby="harness-scan-title">
      <div className="harness-scan-heading">
        <div>
          <h2 id="harness-scan-title">Coding agents</h2>
          <p>Installed agents and sign-ins on this device.</p>
        </div>
        {onRefresh ? (
          <TextButton className="harness-refresh" tone="muted" disabled={refreshing} onClick={onRefresh}>
            <RefreshCw className={cn(refreshing && "onboarding-spin")} size={13} />
            {refreshing ? "Rescanning" : "Rescan"}
          </TextButton>
        ) : null}
      </div>
      <div
        className="harness-list"
        role={selection?.mode === "default" ? "radiogroup" : "group"}
        aria-label={selectionLabel}
        aria-busy={refreshing || rows.some((row) => row.state === "checking") || undefined}
      >
        {rows.map((row) => {
          let selected = false;
          if (selection?.mode === "multiple") selected = selection.selectedIds.includes(row.id);
          else if (selection?.mode === "default") selected = selection.selectedId === row.id;
          return (
            <div className="harness-row" data-selected={selected || undefined} data-state={row.state} key={row.id}>
              <span className="harness-provider-mark">
                <img className="harness-provider-logo" data-provider={row.id} src={harnessLogos[row.id]} alt={`${harnessCatalog[row.id].name} logo`} />
              </span>
              <div className="harness-content">
                <div className="harness-identity">
                  <h3>{harnessCatalog[row.id].name}</h3>
                  <StatusBadge state={row.state} />
                </div>
                <p className="harness-guidance">{stateGuidance[row.state]}</p>
              </div>
              <div className="harness-action">
                <RowAction row={row} selection={selection} onRetry={onRetry} onConnect={onConnect} onSetup={onSetup} />
              </div>
              {row.version || row.path ? (
                <details className="harness-details">
                  <summary>
                    <span className="sr-only">{harnessCatalog[row.id].name} </span>Details <ChevronDown size={12} />
                  </summary>
                  <div className="harness-meta">
                    {row.version ? (
                      <span>
                        <strong>Version</strong> {row.version}
                      </span>
                    ) : null}
                    {row.path ? (
                      <span>
                        <strong>Path</strong> <code title={row.path}>{row.path}</code>
                      </span>
                    ) : null}
                  </div>
                </details>
              ) : null}
            </div>
          );
        })}
      </div>
      {refreshing ? (
        <p className="harness-refresh-note" role="status">
          Keeping the last results visible while the new check finishes.
        </p>
      ) : null}
    </section>
  );
}
