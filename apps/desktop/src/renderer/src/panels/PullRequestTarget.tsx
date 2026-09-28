import { useState } from "react";
import type { Project } from "@openorc/protocol";
import { BranchPicker } from "../components/BranchPicker";
import { Field } from "../components/ui";
import { pullRequestTarget } from "../lib/pull-requests";
import { useRpc } from "../lib/query";

export interface TargetBranch {
  /** The branch the pull request merges into; null while there is none to suggest. */
  value: string | null;
  choose: (branch: string) => void;
  options: string[];
  loading: boolean;
  error: Error | null;
}

/**
 * The branch a new pull request merges into: where its work started, until you choose another. GitHub's branches load
 * once the dialog opens.
 */
export function useTargetBranch({ project, started, head, open }: { project: Project; started: string | null; head: string | null; open: boolean }): TargetBranch {
  const prefer = started ?? project.defaultBranch;
  const branches = useRpc("pulls.branches", { projectId: project.id, ...(prefer ? { prefer } : {}) }, { enabled: open });
  const [chosen, setChosen] = useState<string | null>(null);
  const suggested = pullRequestTarget({ started, projectDefault: project.defaultBranch, head, branches: branches.data });
  const listed = branches.data?.branches ?? (suggested ? [suggested] : []);
  return { value: chosen ?? suggested, choose: setChosen, options: listed.filter((branch) => branch !== head), loading: branches.isPending, error: branches.error };
}

export function TargetBranchField({ target, disabled }: { target: TargetBranch; disabled: boolean }) {
  return (
    <Field label="Target branch">
      <BranchPicker branches={target.options} value={target.value} onChange={target.choose} disabled={disabled || target.loading || Boolean(target.error)} />
      {target.error ? <span className="text-sm text-bad break-words">{target.error.message}</span> : null}
    </Field>
  );
}
