import { Select } from "../components/ui";
import { useHostChoice } from "../lib/host-choice";
import { thisComputer } from "../lib/this-computer";
import { Field, Section } from "./settings-shared";

/**
 * Where OpenOrc runs: this PC, or inside a WSL distribution. Only a PC with a WSL distribution has anything to choose,
 * so everywhere else this shows nothing.
 */
export function HostSettingsSection() {
  const host = useHostChoice();
  if (!host.options) return null;
  return (
    <Section
      title="Runs on"
      description={`On ${thisComputer}, OpenOrc uses the agents, Git and shell installed on Windows. Inside a WSL distribution it uses the ones installed there, as a terminal in that distribution does, and opens the folders inside it. Each place keeps its own projects and conversations.`}
    >
      <Field
        label="Run OpenOrc on"
        hint="Switching restarts OpenOrc’s core, so it waits for agents and terminals to finish. The first time in a distribution, OpenOrc installs what it needs in ~/.openorc-wsl there, including its own copy of Node from nodejs.org."
      >
        <Select value={host.value} disabled={host.pending} onChange={(e) => host.choose(e.target.value)}>
          {host.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
      </Field>
      {host.refused && (
        <p role="alert" className="text-bad mt-3">
          {host.refused}
        </p>
      )}
      {host.failed && (
        <p role="alert" className="text-bad mt-3">
          Could not switch. OpenOrc is still running where it was.
        </p>
      )}
    </Section>
  );
}
