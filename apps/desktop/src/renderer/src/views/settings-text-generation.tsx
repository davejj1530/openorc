import { textGenerationStatus } from "./settings-presentation";
import { useId } from "react";
import { harnessCatalog, harnessIds, isHarnessId, type TextGenerationSettings as Preferences } from "@openorc/protocol";
import { Button, Select } from "../components/ui";
import { ModelPicker } from "../components/ModelPicker";
import { Field, LoadError, SaveStatus, Section, usePreference } from "./settings-shared";

export function TextGenerationSettings() {
  const s = usePreference("textGeneration.settings.set");
  const v = s.value;
  const provider = v.provider ?? "auto";
  const explicitProvider = isHarnessId(provider) ? provider : null;
  const modelLabelId = useId();
  const modelHintId = useId();
  return (
    <>
      {s.query.isError && <LoadError retry={() => void s.query.refetch()} />}
      <Section title="Text generation" description="Names new threads with a small model. Works independently of memory distillation and your conversation model.">
        <Field label="Harness" hint="Automatic names each conversation with a small model from the agent it uses, so its text stays with that provider. A chosen harness names every conversation.">
          <Select value={provider} disabled={s.disabled} onChange={(event) => void s.commit({ provider: event.target.value as Preferences["provider"] })}>
            <option value="auto">Automatic · the conversation's agent</option>
            {harnessIds.map((id) => (
              <option key={id} value={id}>
                {harnessCatalog[id].name}
              </option>
            ))}
            <option value="off">Off · use opening message</option>
          </Select>
        </Field>
        {explicitProvider && (
          <div className="settings-field" role="group" aria-labelledby={modelLabelId} aria-describedby={modelHintId}>
            <span>
              <span id={modelLabelId} className="font-medium">
                Model
              </span>
              <span id={modelHintId} className="block text-sm text-ink-2 mt-1">
                The default uses a small model. Choosing a larger model may cost more or use more of your allowance.
              </span>
            </span>
            <div className="flex min-w-0 flex-col items-end gap-1">
              <ModelPicker
                value={v.model ? { agent: explicitProvider, model: v.model, effort: null } : null}
                placeholder="Low-cost default"
                ariaLabel="Text generation model"
                showEffort={false}
                disabled={s.disabled || s.status === "error"}
                onChange={(choice) => {
                  if (isHarnessId(choice.agent)) void s.commit({ provider: choice.agent, model: choice.model });
                }}
              />
              {v.model ? (
                <Button size="sm" disabled={s.disabled || s.status === "error"} onClick={() => void s.commit({ provider: explicitProvider, model: null })}>
                  Use low-cost default
                </Button>
              ) : null}
            </div>
          </div>
        )}
        <p className="text-ink-2 mt-3" role="status">
          {textGenerationStatus({ loading: s.query.isLoading, status: s.status, value: v })}
        </p>
      </Section>
      <SaveStatus status={s.status} retry={() => void s.retry()} />
    </>
  );
}
