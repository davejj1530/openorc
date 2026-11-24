import { useEffect, useState } from "react";
import { DEFAULT_SPEECH_MODEL, type DictationEngine, type DictationSettings, type SpeechModelState } from "../../../shared/dictation";
import { Button, Input, Select } from "../components/ui";
import { connectDictation, setMicrophone, useDictation } from "../lib/dictation/dictation";
import { Field, Section, SettingRow, Status } from "./settings-shared";

const megabytes = (bytes: number) => `${Math.round(bytes / 1_000_000)} MB`;

/** The input devices the system lists by name. It names them only once the app may hear a microphone, so before the first recording there are none. */
function useMicrophones(): MediaDeviceInfo[] {
  const [inputs, setInputs] = useState<MediaDeviceInfo[]>([]);
  useEffect(() => {
    const devices = navigator.mediaDevices;
    const read = () =>
      void devices.enumerateDevices().then(
        // The system's own choice is listed again under two ids of its own, which the first option already offers.
        (all) => setInputs(all.filter((device) => device.kind === "audioinput" && device.label && device.deviceId !== "default" && device.deviceId !== "communications")),
        () => setInputs([]),
      );
    read();
    devices.addEventListener("devicechange", read);
    return () => devices.removeEventListener("devicechange", read);
  }, []);
  return inputs;
}

/** What the model's row offers: get it, stop getting it, or give its room back. */
function ModelControls({ state }: { state: SpeechModelState | undefined }) {
  const api = window.openorc.dictation;
  const model = DEFAULT_SPEECH_MODEL;
  if (state?.phase === "ready")
    return (
      <>
        <Status ok>Downloaded</Status>
        <Button size="sm" onClick={() => void api.remove(model.id)}>
          Remove
        </Button>
      </>
    );
  if (state?.phase === "downloading")
    return (
      <>
        <span className="tabular text-ink-3">{Math.floor((state.received / model.bytes) * 100)}%</span>
        <Button size="sm" onClick={() => void api.cancelDownload(model.id)}>
          Cancel
        </Button>
      </>
    );
  return (
    <Button size="sm" disabled={!state} onClick={() => void api.download(model.id)}>
      {state?.phase === "failed" ? "Try again" : "Download"}
    </Button>
  );
}

/**
 * The key OpenAI transcribes on. It is saved by main in protected storage and never read back here: the field only
 * takes a new one, and says whether one is saved.
 */
function OpenAiKey({ settings }: { settings: DictationSettings }) {
  const [key, setKey] = useState("");
  const [refused, setRefused] = useState<string | null>(null);
  const save = (next: string) => {
    setKey("");
    window.openorc.dictation.setOpenAiKey(next).then(
      () => setRefused(null),
      () => setRefused("The key could not be saved in protected storage."),
    );
  };
  return (
    <SettingRow
      label="OpenAI API key"
      hint={
        refused ??
        (settings.openaiKey
          ? "A key is saved in protected OS storage. Enter a replacement to update it."
          : "Stored with OS protection. While you dictate, your voice goes to OpenAI and is billed to this key.")
      }
    >
      <Input type="password" autoComplete="off" aria-label="OpenAI API key" className="w-56" value={key} placeholder="Enter API key" onChange={(event) => setKey(event.target.value)} />
      <Button size="sm" disabled={!key.trim()} onClick={() => save(key)}>
        Save
      </Button>
      {settings.openaiKey ? (
        <Button size="sm" onClick={() => save("")}>
          Remove
        </Button>
      ) : null}
    </SettingRow>
  );
}

/**
 * Dictation's engine, its model or key, and the microphone. Main keeps all but the microphone choice, so this reads
 * and changes them over the window's own channel.
 */
export function DictationSettingsSection() {
  const model = DEFAULT_SPEECH_MODEL;
  const settings = useDictation((s) => s.settings);
  const state = useDictation((s) => s.models[model.id]);
  const microphone = useDictation((s) => s.microphone);
  const inputs = useMicrophones();
  useEffect(() => void connectDictation(), []);
  if (!window.openorc?.dictation) return null;
  return (
    <Section title="Dictation">
      <Field label="Transcribe with">
        <Select value={settings?.engine ?? "local"} disabled={!settings} onChange={(event) => void window.openorc.dictation.setEngine(event.target.value as DictationEngine)}>
          <option value="local">This computer</option>
          <option value="openai">OpenAI</option>
        </Select>
      </Field>
      {settings?.engine === "openai" ? (
        <OpenAiKey settings={settings} />
      ) : (
        <SettingRow label="Speech model" hint={state?.phase === "failed" ? state.reason : `${model.name} by ${model.credit} · ${model.languages} · ${megabytes(model.bytes)}`}>
          <ModelControls state={state} />
        </SettingRow>
      )}
      <Field label="Microphone">
        <Select value={inputs.some((input) => input.deviceId === microphone) ? (microphone ?? "") : ""} onChange={(event) => setMicrophone(event.target.value || null)}>
          <option value="">System default</option>
          {inputs.map((input) => (
            <option key={input.deviceId} value={input.deviceId}>
              {input.label}
            </option>
          ))}
        </Select>
      </Field>
    </Section>
  );
}
