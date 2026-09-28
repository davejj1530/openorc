import { useMutation, useQuery } from "@tanstack/react-query";
import type { UpdateSettings } from "../../../shared/types";
import { queryClient } from "../lib/query";
import { LoadError, Section, Toggle } from "./settings-shared";

const key = ["updates.settings"];

/** The main process owns the updater and this preference, so it is read and saved over the window's own channel. */
export function UpdateSettingsSection() {
  const settings = useQuery({ queryKey: key, queryFn: () => window.openorc.updates.settings() });
  const save = useMutation({
    mutationFn: (on: boolean) => window.openorc.updates.setAutomaticChecks(on),
    onSuccess: (result) => queryClient.setQueryData<UpdateSettings>(key, result),
  });
  const menu = window.openorc.platform === "darwin" ? "the OpenOrc menu" : "the Help menu";
  return (
    <Section title="Updates">
      {settings.isError && <LoadError retry={() => void settings.refetch()} />}
      <Toggle
        label="Check for updates automatically"
        hint={`Shortly after OpenOrc starts and every six hours, it asks GitHub whether a newer release exists. Nothing downloads or installs until you choose to. With this off, use Check for updates in ${menu}.`}
        checked={(save.isPending ? save.variables : undefined) ?? settings.data?.automaticChecks ?? true}
        disabled={!settings.data || save.isPending}
        onChange={(on) => save.mutate(on)}
      />
      {settings.data?.unavailable && <p className="text-ink-2 mt-3">{settings.data.unavailable}</p>}
      {save.isError && (
        <p role="alert" className="text-bad mt-3">
          Could not save. Your previous setting is still active.
        </p>
      )}
    </Section>
  );
}
