import { Menu } from "@base-ui/react/menu";
import { useState, type ReactNode } from "react";
import { SkillName, type SkillPlace } from "@openorc/protocol";
import { PenSquare, Plus, Upload, Wand } from "../components/icons";
import { menuItem, menuPopup } from "../components/menu";
import { Button, Dialog, IconButton, Input, Segmented, Textarea } from "../components/ui";
import { CoversPreview } from "../lib/browser-preview";
import { useRpcMutation } from "../lib/client";
import { openNewThreadWith } from "../lib/new-thread-prefill";
import { floatingGround } from "../lib/use-anchor-ground";
import { createPrompt, finalSkillName, skillNameInput, type SkillsPlace } from "./settings-skills-model";

type AddMode = { kind: "write" } | { kind: "upload"; folder: string };

const places = [
  { value: "user", label: "Yours" },
  { value: "project", label: "This project" },
] as const;

const folderName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

function Labelled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="skill-form-field">
      <span>{label}</span>
      {children}
    </label>
  );
}

/** What the new skill is: written here as a name, a description and instructions, or a folder chosen on disk. */
function WriteFields({ name, description, instructions, onChange }: { name: string; description: string; instructions: string; onChange: (patch: Partial<WriteDraft>) => void }) {
  return (
    <>
      <Labelled label="Name">
        <Input value={name} onChange={(event) => onChange({ name: skillNameInput(event.target.value) })} placeholder="release-notes" autoFocus spellCheck={false} />
      </Labelled>
      <Labelled label="Description">
        <Input value={description} onChange={(event) => onChange({ description: event.target.value })} placeholder="Write release notes from the merged pull requests" />
      </Labelled>
      <Labelled label="Instructions">
        <Textarea className="skill-form-instructions" value={instructions} onChange={(event) => onChange({ instructions: event.target.value })} rows={8} />
      </Labelled>
    </>
  );
}

interface WriteDraft {
  name: string;
  description: string;
  instructions: string;
}

function writeProblem(draft: WriteDraft): string | null {
  if (!SkillName.safeParse(finalSkillName(draft.name)).success) return "Use lowercase letters, numbers and hyphens in the name.";
  return draft.description.trim() ? null : "Add a description.";
}

/** Writes a new skill, or copies a chosen folder in, for this agent: the user's own, or this project's. */
function NewSkillForm({ mode, place, onClose, onAdded }: { mode: AddMode; place: SkillsPlace; onClose: () => void; onAdded: (skill: string) => void }) {
  const create = useRpcMutation("skills.create");
  const copy = useRpcMutation("skills.import");
  const [where, setWhere] = useState<SkillPlace>("user");
  const [draft, setDraft] = useState<WriteDraft>({ name: "", description: "", instructions: "" });
  const [problem, setProblem] = useState<string | null>(null);
  const target = { agent: place.agent, scope: place.scope, place: where };
  const done = {
    onSuccess: ({ skill }: { skill: string }) => {
      onAdded(skill);
      onClose();
    },
  };
  const submit = () => {
    if (mode.kind === "upload") return copy.mutate({ ...target, from: mode.folder }, done);
    const found = writeProblem(draft);
    setProblem(found);
    if (!found) create.mutate({ ...target, name: finalSkillName(draft.name), description: draft.description.trim(), instructions: draft.instructions }, done);
  };
  const failure = problem ?? create.error?.message ?? copy.error?.message;
  return (
    <form
      className="skill-form"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      {mode.kind === "write" ? (
        <WriteFields {...draft} onChange={(patch) => setDraft((current) => ({ ...current, ...patch }))} />
      ) : (
        <Labelled label="Folder">
          <span className="skill-form-folder" title={mode.folder}>
            {folderName(mode.folder)}
          </span>
        </Labelled>
      )}
      <div className="skill-form-field">
        <span>Add to</span>
        <Segmented label="Add to" value={where} options={places} onChange={setWhere} />
      </div>
      {failure ? (
        <p role="alert" className="text-sm text-bad">
          {failure}
        </p>
      ) : null}
      <div className="skill-form-actions">
        <Button onClick={onClose}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={create.isPending || copy.isPending}>
          Add skill
        </Button>
      </div>
    </form>
  );
}

/** The list's + menu: write a skill here, have an agent write one in a new thread, or bring in a skill folder. */
export function AddSkillMenu({ place, onAdded }: { place: SkillsPlace; onAdded: (skill: string) => void }) {
  const [mode, setMode] = useState<AddMode>({ kind: "write" });
  const [open, setOpen] = useState(false);
  // A new form for every opening, so nothing typed into the last one comes back.
  const [opening, setOpening] = useState(0);
  const show = (next: AddMode) => {
    setMode(next);
    setOpening((count) => count + 1);
    setOpen(true);
  };
  const upload = async () => {
    const folder = await window.openorc.pickDirectory();
    if (folder) show({ kind: "upload", folder });
  };
  return (
    <>
      <Menu.Root>
        <Menu.Trigger render={<IconButton aria-label="Add a skill" />}>
          <Plus size={16} />
        </Menu.Trigger>
        <Menu.Portal>
          <CoversPreview />
          <Menu.Positioner sideOffset={6} align="end" className="z-40" collisionPadding={8}>
            <Menu.Popup ref={floatingGround} className={menuPopup}>
              <Menu.Item className={menuItem} onClick={() => show({ kind: "write" })}>
                <PenSquare size={14} />
                Write a skill
              </Menu.Item>
              <Menu.Item className={menuItem} onClick={() => void openNewThreadWith({ projectId: place.projectId, agent: place.agent, prompt: createPrompt(place.agent) })}>
                <Wand size={14} />
                Create with an agent
              </Menu.Item>
              <Menu.Item className={menuItem} onClick={() => void upload()}>
                <Upload size={14} />
                Upload a skill
              </Menu.Item>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
      <Dialog open={open} onOpenChange={setOpen} title={mode.kind === "write" ? "Write a skill" : "Upload a skill"} width={520}>
        <NewSkillForm key={opening} mode={mode} place={place} onClose={() => setOpen(false)} onAdded={onAdded} />
      </Dialog>
    </>
  );
}
