import { Suspense, type ReactNode } from "react";
import { formatBytes } from "@openorc/client";
import type { AgentSkill, SkillFileRead } from "@openorc/protocol";
import { CodeEditor } from "../components/code-editor";
import { Code2, Eye, Pencil } from "../components/icons";
import { ThreadMedia, ThreadRichText } from "../components/ThreadImages";
import { Button, Segmented, Tooltip } from "../components/ui";
import { useRpc } from "../lib/client";
import { useWordWrap } from "../lib/word-wrap";
import { isUnsaved, type SkillDrafts } from "./settings-skills-data";
import { useSkillEditing, type SkillEditing } from "./settings-skills-editing";
import { absoluteFolder, isMarkdown, skillRef, splitFrontmatter, type SkillsPlace } from "./settings-skills-model";

export type FileView = "preview" | "source";

const viewOptions = [
  {
    value: "preview",
    label: (
      <>
        <Eye size={14} />
        <span className="sr-only">Preview</span>
      </>
    ),
  },
  {
    value: "source",
    label: (
      <>
        <Code2 size={14} />
        <span className="sr-only">Source</span>
      </>
    ),
  },
] as const;

function FileStatus({ children }: { children: ReactNode }) {
  return (
    <p role="status" className="skill-file-status">
      {children}
    </p>
  );
}

/** Rendered like a reply. The header is left out: the name and description already show above. */
function SkillPreview({ skill, file, text }: { skill: AgentSkill; file: string; text: string }) {
  const { body } = splitFrontmatter(text);
  const path = `${absoluteFolder(skill)}/${file}`;
  return (
    <ThreadMedia scopeKey={path} basePath={path.replace(/\/[^/]*$/, "")} fileLinks="cite">
      <div className="skill-file-scroll skill-preview text-md text-ink prose-chat">
        {body.trim() ? <ThreadRichText mode="static">{body}</ThreadRichText> : <p className="text-sm text-ink-3">This file is empty.</p>}
      </div>
    </ThreadMedia>
  );
}

function SkillSource({ sessionKey, file, text, editing }: { sessionKey: string; file: string; text: string; editing: SkillEditing }) {
  const wrap = useWordWrap();
  return (
    <div className="skill-file-editor">
      <Suspense fallback={<FileStatus>Loading editor…</FileStatus>}>
        <CodeEditor
          sessionKey={sessionKey}
          path={file}
          text={text}
          readOnly={!editing.draft || editing.saving}
          lineWrapping={wrap.wrap}
          onLineWrappingChange={wrap.setWrap}
          reveal={null}
          onChange={editing.edit}
          onSave={editing.save}
        />
      </Suspense>
    </div>
  );
}

/** Whether the file is ready to edit here, or why not when it is text the user can't change. */
function editState(skill: AgentSkill, read: SkillFileRead | undefined): { can: boolean; reason: string | null } {
  if (read?.kind !== "text") return { can: false, reason: null };
  if (read.readOnly !== null) return { can: false, reason: read.readOnly };
  return { can: skill.editable !== false, reason: null };
}

function ReadingHead({
  skill,
  file,
  read,
  view,
  onView,
  onEdit,
}: {
  skill: AgentSkill;
  file: string;
  read: SkillFileRead | undefined;
  view: FileView;
  onView: (view: FileView) => void;
  onEdit: () => void;
}) {
  const edit = editState(skill, read);
  return (
    <>
      {read?.kind === "text" && isMarkdown(file) ? <Segmented size="sm" label="Show as" value={view} options={viewOptions} onChange={onView} className="skill-view-toggle" /> : null}
      {edit.can ? (
        <Button size="sm" onClick={onEdit}>
          <Pencil size={13} />
          Edit
        </Button>
      ) : null}
      {edit.reason ? (
        <Tooltip label={edit.reason}>
          <span className="skill-read-only" tabIndex={0}>
            Read only
          </span>
        </Tooltip>
      ) : null}
    </>
  );
}

function EditingHead({ editing }: { editing: SkillEditing }) {
  return (
    <>
      <Button size="sm" onClick={editing.cancel}>
        Cancel
      </Button>
      <Button size="sm" variant="primary" disabled={!isUnsaved(editing.draft) || editing.saving} onClick={editing.save}>
        Save
      </Button>
    </>
  );
}

function ConflictNotice({ file, editing }: { file: string; editing: SkillEditing }) {
  const current = editing.draft?.conflict;
  if (!current) return null;
  const text = current.kind === "text";
  return (
    <div role="status" className="skill-file-notice">
      <span>{text ? `${file} changed after you started editing.` : `${file} can't be read now. Your text is still here to copy.`}</span>
      {text ? (
        <Button size="sm" onClick={editing.keepMine}>
          Keep mine
        </Button>
      ) : null}
      <Button size="sm" onClick={editing.takeCurrent}>
        {text ? "Use new version" : "Discard"}
      </Button>
    </div>
  );
}

function FileBody({ skill, file, read, view, editing }: { skill: AgentSkill; file: string; read: { data: SkillFileRead | undefined; error: Error | null }; view: FileView; editing: SkillEditing }) {
  const sessionKey = `skill:${skill.path}:${file}`;
  if (editing.draft) return <SkillSource sessionKey={sessionKey} file={file} text={editing.draft.text} editing={editing} />;
  const data = read.data;
  if (!data) return <FileStatus>{read.error?.message ?? "Loading…"}</FileStatus>;
  if (data.kind === "binary") return <FileStatus>Binary file, {formatBytes(data.bytes)}</FileStatus>;
  if (data.kind === "missing") return <FileStatus>This file is gone.</FileStatus>;
  if (data.kind === "unreadable") return <FileStatus>{data.reason}</FileStatus>;
  if (view === "preview" && isMarkdown(file)) return <SkillPreview skill={skill} file={file} text={data.text} />;
  return <SkillSource sessionKey={sessionKey} file={file} text={data.text} editing={editing} />;
}

/** One file of the skill: read as Markdown or as source, and edited in place when it is the user's. */
export function SkillFileView({
  place,
  skill,
  file,
  drafts,
  view,
  onView,
}: {
  place: SkillsPlace;
  skill: AgentSkill;
  file: string;
  drafts: SkillDrafts;
  view: FileView;
  onView: (view: FileView) => void;
}) {
  const read = useRpc("skills.readFile", { ...skillRef(place, skill), file }, { enabled: place.active });
  const editing = useSkillEditing({ place, skill, file, read: read.data, drafts });
  return (
    <div className="skill-file" data-plane="">
      <div className="skill-file-head">
        <span className="skill-file-path">
          <span className="truncate">{file}</span>
          {isUnsaved(editing.draft) ? <span className="skill-unsaved" role="img" aria-label="Unsaved changes" /> : null}
        </span>
        {editing.draft ? <EditingHead editing={editing} /> : <ReadingHead skill={skill} file={file} read={read.data} view={view} onView={onView} onEdit={editing.begin} />}
      </div>
      <ConflictNotice file={file} editing={editing} />
      {editing.error ? (
        <p role="alert" className="skill-file-notice text-bad">
          {editing.error}
        </p>
      ) : null}
      <FileBody skill={skill} file={file} read={read} view={view} editing={editing} />
    </div>
  );
}
