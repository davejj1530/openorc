import { useRef, useState, type ReactNode } from "react";
import type { RpcParams, RpcResults } from "@openorc/protocol";
import { Button, Switch } from "../components/ui";
import { queryClient, useRpc, useRpcMutation } from "../lib/query";

const preferenceQueries = { "app.settings.set": "app.settings.get", "memory.settings.set": "memory.settings.get", "textGeneration.settings.set": "textGeneration.settings.get" } as const;

export function usePreference<M extends keyof typeof preferenceQueries>(method: M) {
  const get = preferenceQueries[method];
  const query = useRpc<(typeof preferenceQueries)[keyof typeof preferenceQueries]>(get, {});
  const mutation = useRpcMutation(method);
  const [draft, setDraft] = useState<RpcParams<M> | null>(null);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const busy = useRef(false);
  const commit = async (patch: RpcParams<M>): Promise<boolean> => {
    if (busy.current) return false;
    busy.current = true;
    setDraft(patch);
    setStatus("saving");
    try {
      const result = await mutation.mutateAsync(patch);
      queryClient.setQueryData([get, {}], result);
      setDraft(null);
      setStatus("saved");
      mutation.reset();
      return true;
    } catch {
      setStatus("error");
      return false;
    } finally {
      busy.current = false;
    }
  };
  return {
    query,
    error: mutation.error,
    // Each setter returns its paired getter's settings shape. TypeScript cannot carry that
    // relationship through a generic lookup in preferenceQueries.
    value: { ...query.data, ...draft } as unknown as Partial<RpcResults[M]>,
    commit,
    status,
    disabled: !query.data || status === "saving",
    retry: () => (draft ? commit(draft) : Promise.resolve(false)),
  };
}

export function SaveStatus({ status, retry }: { status: string; retry: () => void }) {
  return (
    <div className="settings-feedback" role="status" aria-live="polite">
      {saveStatusContent(status, retry)}
    </div>
  );
}

/** A settings group. `flush` opts out of the plane for a group that already IS a container
 *  of its own, so nothing ends up as a card inside a card. */
export function Section({ id, title, children, description, flush }: { id?: string; title: string; children: ReactNode; description?: string; flush?: boolean }) {
  return (
    <section id={id} className="settings-section">
      <h2 className="text-lg font-semibold">{title}</h2>
      {description && <p className="text-ink-2 mt-1 mb-3">{description}</p>}
      <div className={flush ? "mt-2" : "settings-group"}>{children}</div>
    </section>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="settings-field">
      <span>
        <span className="font-medium">{label}</span>
        {hint && <span className="block text-sm text-ink-2 mt-1">{hint}</span>}
      </span>
      {children}
    </label>
  );
}

export function Toggle({ label, hint, checked, disabled, onChange }: { label: string; hint?: string; checked: boolean; disabled: boolean; onChange: (checked: boolean) => void }) {
  return (
    <Field label={label} hint={hint}>
      <Switch checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
    </Field>
  );
}

export function LoadError({ retry }: { retry: () => void }) {
  return (
    <p role="alert" className="text-bad my-3">
      Could not load settings.{" "}
      <Button size="sm" onClick={retry}>
        Try again
      </Button>
    </p>
  );
}

function saveStatusContent(status: string, retry: () => void) {
  if (status === "saving") {
    return "Saving…";
  }
  if (status === "saved") {
    return "Saved";
  }
  if (status === "error") {
    return (
      <span className="text-bad">
        Could not save. Your change is still here.{" "}
        <Button size="sm" onClick={retry}>
          Retry save
        </Button>
      </span>
    );
  }
  return "Changes save automatically.";
}
