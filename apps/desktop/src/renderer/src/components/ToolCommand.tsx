import { useMemo, useState } from "react";
import { readStep, type CommandStep } from "@openorc/client";
import { Folder as FolderIcon } from "./icons";
import { Code } from "./ToolPrinted";

/** Steps shown before the rest fold behind a count; a fold that would hide only a couple shows them instead. */
const STEPS = 10;
/** Lines of a step's script shown before it folds. */
const SCRIPT_LINES = 10;
const SLACK = 3;

/** "…/renderer/src": enough of a folder to place it. */
export function shortPath(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : path;
}

/**
 * A command as the steps it ran, each in plain words with the command itself beside them, faint, on one line. The
 * part of a step that only trims what it printed steps back further. Pressing a step shows its whole command.
 */
export function CommandSteps({ steps, cwd }: { steps: CommandStep[]; cwd: string | null }) {
  const [all, setAll] = useState(false);
  const folds = steps.length > STEPS + SLACK;
  const shown = folds && !all ? steps.slice(0, STEPS) : steps;
  return (
    <div className="tool-view-command">
      {cwd ? <Folder path={cwd} /> : null}
      <ol className="tool-view-steps">
        {shown.map((step, index) => (
          <Step key={index} step={step} />
        ))}
      </ol>
      {folds ? (
        <button type="button" className="tool-view-more" aria-expanded={all} onClick={() => setAll((value) => !value)}>
          {all ? "Show less" : `${steps.length - STEPS} more steps`}
        </button>
      ) : null}
    </div>
  );
}

function Folder({ path }: { path: string }) {
  return (
    <span className="tool-view-cwd" title={path}>
      <FolderIcon size={12} />
      {shortPath(path)}
    </span>
  );
}

function Step({ step }: { step: CommandStep }) {
  const { label, detail, plumbing } = useMemo(() => readStep(step.text), [step.text]);
  const [open, setOpen] = useState(false);
  // A comment the agent left between steps reads as its note, not as something that ran.
  if (step.text.startsWith("#")) return <li className="tool-view-note-step">{step.text.replace(/^#+\s*/, "")}</li>;
  // A `cd` partway through says where the steps after it run, as the folder at the top does.
  const folder = /^cd\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s*$/.exec(step.text);
  if (folder)
    return (
      <li className="tool-view-note-step">
        <Folder path={folder[1] ?? folder[2] ?? folder[3]!} />
      </li>
    );
  return (
    <li className="tool-view-step" data-bare={label ? undefined : ""}>
      <button
        type="button"
        className="tool-view-step-row"
        aria-expanded={open}
        title={open ? undefined : step.text}
        // Selecting part of the command to copy it is not a press.
        onClick={() => window.getSelection()?.isCollapsed !== false && setOpen((value) => !value)}
      >
        {label ? (
          <span className="tool-view-step-label">
            {label}
            {detail ? <span className="tool-view-step-detail">{detail}</span> : null}
          </span>
        ) : null}
        <code className="tool-view-step-command">
          {plumbing === null ? (
            step.text
          ) : (
            <>
              {step.text.slice(0, plumbing)}
              <span className="tool-view-plumbing">{step.text.slice(plumbing)}</span>
            </>
          )}
        </code>
      </button>
      {step.body ? <Script code={step.body.code} language={step.body.language} /> : null}
    </li>
  );
}

/** The script a step feeds in, set under it; a long one shows its first lines and fades. */
function Script({ code, language }: { code: string; language: string }) {
  const [all, setAll] = useState(false);
  const lines = useMemo(() => code.split("\n"), [code]);
  const folds = lines.length > SCRIPT_LINES + SLACK;
  return (
    <div className="tool-view-script" data-folded={(folds && !all) || undefined}>
      <Code code={folds && !all ? lines.slice(0, SCRIPT_LINES).join("\n") : code} language={language} startLine={null} script />
      {folds ? (
        <button type="button" className="tool-view-more" aria-expanded={all} onClick={() => setAll((value) => !value)}>
          {all ? "Show less" : `Show all ${lines.length} lines`}
        </button>
      ) : null}
    </div>
  );
}
