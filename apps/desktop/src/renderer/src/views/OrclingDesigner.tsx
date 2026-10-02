import { useState } from "react";
import { defaultOrclingLook, isHarnessId, orclingHandle, type Orcling, type OrclingDraft, type OrclingLook, type OrclingLookPart, type OrclingPermission } from "@openorc/protocol";
import { cn } from "../lib/cn";
import { defaultChoice, pickerCatalog, type ModelChoice } from "../lib/model-picker-selection";
import { useOrclings } from "../lib/orclings";
import { useRpcMutation } from "../lib/query";
import { openThread, useRouter } from "../lib/router";
import { useModelCatalog } from "../lib/use-model-catalog";
import { ArrowLeft } from "../components/icons";
import { ModelPicker } from "../components/ModelPicker";
import { OrclingSilhouette, OrclingStill } from "../components/OrclingAvatar";
import { OrclingPreview } from "../components/OrclingPreview";
import { ORCLING_ACCESSORIES, ORCLING_BODY_COLORS, ORCLING_EYE_COLORS, ORCLING_EYES, ORCLING_GLASSES, ORCLING_SHAPES, ORCLING_TEXTURES } from "../components/orcling-art";
import { TopBar } from "../components/TopBar";
import { Button, Dialog, IconButton, Segmented, TextButton } from "../components/ui";
import "./OrclingDesigner.css";

const TABS: readonly { part: OrclingLookPart; label: string; options: readonly { name: string }[] }[] = [
  { part: "shape", label: "Shape", options: ORCLING_SHAPES },
  { part: "eyes", label: "Eyes", options: ORCLING_EYES },
  { part: "texture", label: "Texture", options: ORCLING_TEXTURES },
  { part: "glasses", label: "Glasses", options: ORCLING_GLASSES },
  { part: "accessory", label: "Accessories", options: ORCLING_ACCESSORIES },
];

/** Design a new Orcling, or change one: its look, name, model and permission. */
export function OrclingDesigner({ orclingId }: { orclingId?: string | undefined }) {
  const orclings = useOrclings();
  const models = useModelCatalog();
  const existing = orclingId ? orclings.find((orcling) => orcling.id === orclingId) : undefined;
  // The form starts from what is known once: the Orcling being changed, or a default model for a new one.
  if (orclingId && !existing) return null;
  if (!existing && !models.data) return null;
  return <DesignerForm key={existing?.id ?? "new"} existing={existing} initialModel={existing ? null : defaultChoice(pickerCatalog(models.data ?? []), null)} />;
}

const leave = (existing: Orcling | undefined) => (existing ? openThread(existing.threadId) : useRouter.getState().back());

/** Why a name can't be saved: another Orcling has it, whatever the case or punctuation, or it has no letter or number. */
function nameProblem(name: string, orclings: readonly Orcling[], self: Orcling | undefined): string | null {
  if (!name.trim()) return null;
  const handle = orclingHandle(name);
  if (!handle) return "A name needs a letter or a number.";
  const taken = orclings.find((other) => other.id !== self?.id && orclingHandle(other.name) === handle);
  return taken ? `You already have an Orcling named ${taken.name}.` : null;
}

/** Where the form starts: the Orcling being changed, or a new one on the default model. */
function startingPoint(existing: Orcling | undefined, initialModel: ModelChoice | null): { look: OrclingLook; name: string; model: ModelChoice | null; permission: OrclingPermission } {
  if (!existing) return { look: defaultOrclingLook, name: "", model: initialModel, permission: "approve" };
  return { look: existing.look, name: existing.name, model: { ...existing.settings }, permission: existing.permission };
}

function DesignerForm({ existing, initialModel }: { existing: Orcling | undefined; initialModel: ModelChoice | null }) {
  const [start] = useState(() => startingPoint(existing, initialModel));
  const [look, setLook] = useState(start.look);
  const [name, setName] = useState(start.name);
  const [model, setModel] = useState(start.model);
  const [permission, setPermission] = useState(start.permission);
  const orclings = useOrclings();
  const problem = nameProblem(name, orclings, existing);
  const create = useRpcMutation("orclings.create");
  const update = useRpcMutation("orclings.update");

  const save = () => {
    if (!model || !name.trim() || !isHarnessId(model.agent)) return;
    const draft: OrclingDraft = {
      name: name.trim(),
      look,
      settings: { agent: model.agent, model: model.model, effort: model.effort, fastMode: Boolean(model.fastMode) },
      permission,
    };
    const done = (saved: Orcling) => openThread(saved.threadId);
    if (existing) update.mutate({ id: existing.id, draft }, { onSuccess: done });
    else create.mutate({ draft }, { onSuccess: done });
  };

  return (
    <div className="orcling-designer">
      <TopBar>
        <IconButton onClick={() => leave(existing)} aria-label="Back">
          <ArrowLeft size={15} />
        </IconButton>
        <span className="truncate">{existing?.name ?? "New Orcling"}</span>
      </TopBar>
      <div className="orcling-designer-layout">
        <LookOptions look={look} onChange={setLook} />
        <section className="orcling-designer-card" aria-label="Orcling">
          <input className="orcling-designer-name" value={name} maxLength={40} placeholder="Name" aria-label="Name" onChange={(event) => setName(event.target.value)} />
          {problem ? (
            <p role="alert" className="orcling-designer-error text-center">
              {problem}
            </p>
          ) : null}
          <OrclingPreview look={look} size={260} className="orcling-designer-preview" />
          <div className="orcling-designer-fields">
            <div className="orcling-designer-field">
              <span>Model</span>
              <ModelPicker value={model} onChange={setModel} ariaLabel="Model" />
            </div>
            <div className="orcling-designer-field">
              <span>Permission</span>
              <Segmented
                label="Permission"
                value={permission}
                onChange={setPermission}
                options={[
                  { value: "approve", label: "Approve" },
                  { value: "allow", label: "Allow" },
                ]}
              />
            </div>
          </div>
          <SaveError error={create.error ?? update.error} />
          <Button variant="primary" size="lg" className="orcling-designer-save" disabled={create.isPending || update.isPending || !name.trim() || Boolean(problem) || !model} onClick={save}>
            {existing ? "Save" : "Create Orcling"}
          </Button>
          {existing ? <DeleteOrcling orcling={existing} /> : null}
        </section>
      </div>
    </div>
  );
}

/** The parts of an Orcling's look, one tab at a time, with its colors below. */
function LookOptions({ look, onChange }: { look: OrclingLook; onChange: (look: OrclingLook) => void }) {
  const [tab, setTab] = useState<OrclingLookPart>("shape");
  const current = TABS.find((entry) => entry.part === tab)!;
  return (
    <section className="orcling-designer-options" aria-label="Look">
      <div className="sub-header">
        <Segmented label="Part to change" value={tab} options={TABS.map((entry) => ({ value: entry.part, label: entry.label }))} onChange={setTab} />
      </div>
      <div className="orcling-designer-look">
        <div className="orcling-designer-grid" role="radiogroup" aria-label={current.label}>
          {current.options.map((option, index) => (
            <button
              key={option.name}
              type="button"
              role="radio"
              aria-checked={look[tab] === index}
              aria-label={option.name}
              title={option.name}
              className="orcling-designer-tile"
              onClick={() => onChange({ ...look, [tab]: index })}
            >
              {tab === "shape" ? <OrclingSilhouette shape={index} color={look.bodyColor} size={72} /> : <OrclingStill look={{ ...look, [tab]: index }} size={72} />}
            </button>
          ))}
        </div>
        <div className="orcling-designer-colors">
          <Swatches label="Body color" colors={ORCLING_BODY_COLORS} value={look.bodyColor} onChange={(bodyColor) => onChange({ ...look, bodyColor })} />
          {tab === "eyes" ? <Swatches label="Eye color" colors={ORCLING_EYE_COLORS} value={look.eyeColor} onChange={(eyeColor) => onChange({ ...look, eyeColor })} /> : null}
        </div>
      </div>
    </section>
  );
}

function SaveError({ error }: { error: Error | null }) {
  if (!error) return null;
  return (
    <p role="alert" className="orcling-designer-error">
      {error.message}
    </p>
  );
}

function DeleteOrcling({ orcling }: { orcling: Orcling }) {
  const [open, setOpen] = useState(false);
  const remove = useRpcMutation("orclings.delete");
  return (
    <>
      <TextButton tone="danger" className="orcling-designer-delete" onClick={() => setOpen(true)}>
        Delete {orcling.name}
      </TextButton>
      <Dialog open={open} onOpenChange={setOpen} title={`Delete ${orcling.name}?`}>
        <p className="text-base text-ink-2">Its conversation, instructions and memories go with it. Threads it worked in keep their history.</p>
        {remove.error ? (
          <p role="alert" className="orcling-designer-error mt-2">
            {remove.error.message}
          </p>
        ) : null}
        <div className="flex justify-end gap-2 mt-4">
          <Button onClick={() => setOpen(false)}>Cancel</Button>
          <Button variant="danger" disabled={remove.isPending} onClick={() => remove.mutate({ id: orcling.id }, { onSuccess: () => useRouter.getState().navigate({ view: "newthread" }) })}>
            Delete
          </Button>
        </div>
      </Dialog>
    </>
  );
}

function Swatches({ label, colors, value, onChange }: { label: string; colors: readonly { name: string; hex: string }[]; value: string; onChange: (color: string) => void }) {
  return (
    <div role="radiogroup" aria-label={label} className="orcling-designer-swatches">
      {colors.map((color) => (
        <button
          key={color.hex}
          type="button"
          role="radio"
          aria-checked={value === color.hex}
          aria-label={color.name}
          title={color.name}
          className={cn("orcling-designer-swatch", value === color.hex && "orcling-designer-swatch-selected")}
          style={{ backgroundColor: color.hex }}
          onClick={() => onChange(color.hex)}
        />
      ))}
    </div>
  );
}
