import { useMemo, useState } from "react";
import type { AgentSkill } from "@openorc/protocol";
import { FileGlyph } from "../components/FileGlyph";
import { ChevronRight, Folder } from "../components/icons";
import { cn } from "../lib/cn";
import { useRpc } from "../lib/client";
import { useVisited } from "../lib/use-visited";
import { mainFile, parentFolders, skillRef, skillTitle, skillTree, type SkillsPlace, type SkillTreeEntry } from "./settings-skills-model";

interface TreeProps {
  place: SkillsPlace;
  skill: AgentSkill;
  file: string;
  onFile: (file: string) => void;
  unsaved: (file: string) => boolean;
}

interface EntryProps extends Pick<TreeProps, "file" | "onFile" | "unsaved"> {
  entry: SkillTreeEntry;
  depth: number;
  expanded: readonly string[];
  toggle: (path: string) => void;
}

function TreeEntry({ entry, depth, file, onFile, unsaved, expanded, toggle }: EntryProps) {
  const folder = entry.kind === "directory";
  const open = folder && expanded.includes(entry.path);
  return (
    <li>
      <button
        type="button"
        className="skill-tree-row"
        data-skills-nav=""
        aria-current={entry.path === file || undefined}
        aria-expanded={folder ? open : undefined}
        style={{ paddingLeft: 8 + depth * 18 }}
        onClick={() => (folder ? toggle(entry.path) : onFile(entry.path))}
      >
        {folder ? <ChevronRight size={12} className={cn("skill-tree-chevron", open && "rotate-90")} /> : null}
        {folder ? <Folder size={13} /> : <FileGlyph path={entry.path} size={13} />}
        <span className="truncate">{entry.name}</span>
        {unsaved(entry.path) ? <span className="skill-unsaved" role="img" aria-label="Unsaved changes" /> : null}
      </button>
      {folder ? (
        <ul className="motion-collapse" hidden={!open}>
          {entry.children.map((child) => (
            <TreeEntry key={child.path} entry={child} depth={depth + 1} file={file} onFile={onFile} unsaved={unsaved} expanded={expanded} toggle={toggle} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function SkillTree({ place, skill, file, onFile, unsaved }: TreeProps) {
  const files = useRpc("skills.files", skillRef(place, skill), { enabled: place.active });
  const [expanded, setExpanded] = useState<string[]>(() => parentFolders(file));
  const tree = useMemo(() => skillTree(files.data ?? [], mainFile(skill)), [files.data, skill]);
  const toggle = (path: string) => setExpanded((current) => (current.includes(path) ? current.filter((each) => each !== path) : [...current, path]));
  if (files.isError) return <p className="skill-tree-note">{files.error.message}</p>;
  if (!files.data) return <p className="skill-tree-note">Loading files…</p>;
  return (
    <ul className="skill-tree" aria-label={`${skillTitle(skill)} files`}>
      {tree.map((entry) => (
        <TreeEntry key={entry.path} entry={entry} depth={0} file={file} onFile={onFile} unsaved={unsaved} expanded={expanded} toggle={toggle} />
      ))}
    </ul>
  );
}

/** A selected skill opens in place into its folder; the files read the first time it opens and stay to fold away. */
export function SkillFiles({ open, ...props }: TreeProps & { open: boolean }) {
  const visited = useVisited(open);
  return (
    <div className="motion-collapse" hidden={!open}>
      {visited ? <SkillTree {...props} /> : null}
    </div>
  );
}
