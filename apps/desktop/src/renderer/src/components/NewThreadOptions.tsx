import type { ReactNode } from "react";
import type { NewThreadPlace } from "@openorc/client";
import { WORKSPACE_ID } from "@openorc/protocol";
import type { ComposerChanges, ComposerProps } from "./Composer";
import { ComposerChoice } from "./ComposerChoice";
import { ComposerCommitChip } from "./ComposerFooter";
import { Cloud, Folder, GitBranch, Laptop } from "./icons";
import { Button } from "./ui";

const workspaceOptions = (cloud: boolean) => [
  { value: "current" as const, label: "Local checkout", hint: "The repository as it is checked out now", icon: Laptop },
  { value: "worktree" as const, label: "Worktree", hint: "A branch and folder of its own, so other threads never collide with it", icon: GitBranch },
  { value: "cloud" as const, label: "Cloud", hint: "A sandbox of its own; its changes arrive in a worktree here", icon: Cloud, hidden: !cloud },
];

/** Where the thread will work, said as a sentence. */
function LocationSentence({ mode, branch }: { mode: NewThreadPlace; branch: string | null }) {
  const name = branch ? <span className="composer-branch">{branch}</span> : null;
  if (mode === "cloud") return <span className="new-thread-sentence">Runs in the cloud on a new branch{name ? <> from {name}</> : null}</span>;
  if (mode === "worktree") return <span className="new-thread-sentence">Starts on a new branch{name ? <> from {name}</> : null}</span>;
  return <span className="new-thread-sentence">Works in the local checkout{name ? <> on {name}</> : null}</span>;
}

/** Under the New thread composer: where the thread works (a menu or the Workspace folder), the Claude account and uncommitted changes. */
export function NewThreadOptions(props: {
  projectId: string;
  mode: NewThreadPlace;
  /** Whether Cloud is offered: only targets that run in a sandbox can take it. */
  cloud: boolean;
  location: ComposerProps["location"];
  blocked: string | null;
  disabled: boolean;
  onFolder: (folder: string) => void;
  onMode: (mode: NewThreadPlace) => void;
  account?: ReactNode;
  changes?: ComposerChanges | null;
}) {
  const chooseFolder = async () => {
    const folder = await window.openorc.pickDirectory();
    if (folder) props.onFolder(folder);
  };
  return (
    <div className="new-thread-options" role="group" aria-label="New thread context">
      <div className="new-thread-location">
        {props.projectId === WORKSPACE_ID ? (
          <>
            <span className="new-thread-folder" title={props.location.directory}>
              <Folder size={14} />
              <span>{props.location.directory}</span>
            </span>
            <Button variant="ghost" size="sm" disabled={props.disabled} title="Choose the folder for this conversation" onClick={() => void chooseFolder()}>
              Choose folder
            </Button>
          </>
        ) : (
          <ComposerChoice
            ariaLabel="Where the thread works"
            look="text"
            value={props.mode}
            options={workspaceOptions(props.cloud)}
            trigger={
              <>
                {props.mode === "cloud" ? <Cloud size={14} /> : <GitBranch size={14} />}
                <LocationSentence mode={props.mode} branch={props.location.branch} />
              </>
            }
            side="bottom"
            align="start"
            disabled={props.disabled || Boolean(props.blocked)}
            disabledReason={props.blocked ?? undefined}
            onChange={props.onMode}
          />
        )}
      </div>
      {props.account}
      <ComposerCommitChip changes={props.changes} />
    </div>
  );
}
