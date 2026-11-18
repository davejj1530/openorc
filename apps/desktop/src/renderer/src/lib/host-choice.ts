import { useEffect, useState } from "react";
import type { HostChoice, HostState } from "../../../shared/host";
import type { OpenOrcApi } from "../../../shared/types";
import { ThisComputer } from "./this-computer";

/** Main's controls for where the core runs. A window without the app's bridge, such as a preview or a test, has none. */
const controls = (): OpenOrcApi["host"] | undefined => (window as { openorc?: Partial<OpenOrcApi> }).openorc?.host;

const LOCAL = "local";
const valueOf = (host: HostChoice) => (host.kind === "wsl" ? `wsl:${host.distro}` : LOCAL);
const hostOf = (value: string): HostChoice => (value === LOCAL ? { kind: "local" } : { kind: "wsl", distro: value.slice("wsl:".length) });

export interface HostChoiceState {
  /** The places OpenOrc can run, as a select's options; null where there is only this computer, and nothing to choose. */
  options: { value: string; label: string }[] | null;
  /** The option OpenOrc runs on, or the one it is switching to. */
  value: string;
  pending: boolean;
  /** Why main would not switch yet, in its words. */
  refused: string | null;
  /** The request itself failed; OpenOrc is where it was. */
  failed: boolean;
  choose(value: string): void;
}

/**
 * Where OpenOrc runs: this computer, or a WSL distribution on Windows. Main owns the choice and starts the core there,
 * so it is read and changed over the window's own channel, not the core's; a change reloads the window onto the new
 * core. A window whose bridge has no such controls reads as having only this computer.
 */
export function useHostChoice(): HostChoiceState {
  const [state, setState] = useState<HostState | null>(null);
  const [switching, setSwitching] = useState<HostChoice | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let showing = true;
    void Promise.resolve(controls()?.get()).then(
      (answer) => {
        if (showing) setState(answer ?? null);
      },
      () => undefined,
    );
    return () => {
      showing = false;
    };
  }, []);

  const choose = (value: string) => {
    const host = hostOf(value);
    setSwitching(host);
    setRefused(null);
    setFailed(false);
    void Promise.resolve(controls()?.use(host)).then(
      (answer) => {
        setSwitching(null);
        if (answer && !answer.ok) setRefused(answer.reason);
      },
      () => {
        setSwitching(null);
        setFailed(true);
      },
    );
  };

  const distros = state?.distros ?? [];
  return {
    options: distros.length ? [{ value: LOCAL, label: ThisComputer }, ...distros.map((distro) => ({ value: `wsl:${distro.name}`, label: `WSL: ${distro.name}` }))] : null,
    value: valueOf(switching ?? state?.current ?? { kind: "local" }),
    pending: switching !== null,
    refused,
    failed,
    choose,
  };
}
