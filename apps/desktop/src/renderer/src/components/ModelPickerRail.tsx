import { harnessInfo, harnessInstalled, harnessLoggedIn, harnessName, type HarnessId, type SystemInfo } from "@openorc/protocol";
import { useId, useLayoutEffect, useRef } from "react";
import { useScrollEdges } from "../lib/use-scroll-edges";
import { HarnessLogo } from "./HarnessLogo";
import { fastStatus } from "./ModelPickerEffort";
import { Orcling as OrclingIcon, Zap } from "./icons";

export type PickerSection = HarnessId | "orclings";

function providerHint(status: ReturnType<typeof harnessInfo> | null): string | null {
  if (status && !harnessInstalled(status)) return "Not installed";
  if (status && !harnessLoggedIn(status)) return "Sign in";
  return null;
}

type FastOption = { active: boolean; blocked: boolean; hint: string; disabled: boolean; onToggle: () => void };

export function ModelPickerRail({
  section,
  onSectionChange,
  enabled,
  orclings,
  system,
  fast,
}: {
  section: PickerSection;
  onSectionChange: (section: PickerSection) => void;
  enabled: readonly HarnessId[];
  orclings: boolean;
  system: SystemInfo | undefined;
  fast: FastOption | null;
}) {
  const selected = useRef<HTMLButtonElement>(null);
  const edges = useScrollEdges();
  const fastDescriptionId = useId();
  useLayoutEffect(() => {
    selected.current?.scrollIntoView?.({ block: "nearest" });
  }, [section]);

  return (
    <div className="model-picker-rail" role="group" aria-label="Model providers">
      <div {...edges} className="model-picker-providers scroll-edges">
        {orclings ? (
          <button
            ref={section === "orclings" ? selected : undefined}
            type="button"
            className="model-picker-rail-button"
            aria-label="Orclings"
            aria-pressed={section === "orclings"}
            data-tip="Orclings"
            onClick={() => onSectionChange("orclings")}
          >
            <OrclingIcon size={20} />
          </button>
        ) : null}
        {enabled.map((id) => {
          const hint = providerHint(system ? harnessInfo(system, id) : null);
          const label = `${harnessName(id)}${hint ? ` · ${hint}` : ""}`;
          return (
            <button
              key={id}
              ref={section === id ? selected : undefined}
              type="button"
              className="model-picker-rail-button"
              aria-label={label}
              aria-pressed={section === id}
              data-tip={label}
              onClick={() => onSectionChange(id)}
            >
              <HarnessLogo id={id} size={20} />
            </button>
          );
        })}
      </div>
      {fast ? (
        <>
          <button
            type="button"
            className="model-picker-rail-button model-picker-fast"
            aria-label="Fast mode"
            aria-pressed={fast.active}
            data-blocked={fast.blocked || undefined}
            aria-describedby={fastDescriptionId}
            data-tip={`${fast.active ? "Turn off" : "Request"} Fast mode. ${fast.hint}`}
            disabled={fast.disabled}
            onClick={fast.onToggle}
          >
            <Zap size={20} />
          </button>
          <span className="sr-only" id={fastDescriptionId}>
            {fastStatus(fast.active, fast.blocked)}
            {fast.hint}
          </span>
        </>
      ) : null}
    </div>
  );
}
