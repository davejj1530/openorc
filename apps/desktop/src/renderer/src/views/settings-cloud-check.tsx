import type { CloudCheck, CloudCheckLink, CloudCheckStep } from "@openorc/protocol";
import { Button } from "../components/ui";
import { StepMark } from "../components/WorkSteps";
import { queryClient, useRpc, useRpcMutation } from "../lib/client";
import { useSpaceNavigation } from "../lib/space-navigation";
import { Failure } from "./settings-secret-field";
import { Section, SettingRow } from "./settings-shared";
import "./settings-cloud-check.css";

/** Each link as a step reads. */
const LINKS: Record<CloudCheckStep, string> = {
  server: "Reach OpenOrc Cloud",
  standing: "Your Pro and hours",
  claude: "Your Claude sign-in",
  codex: "Your Codex sign-in",
  opencode: "Your OpenCode keys",
  github: "Your GitHub",
  machine: "Start a test machine",
};

/** How often a check under way is read again. */
const RUNNING_MS = 1_000;

const MARKS = { running: "running", ok: "done", broken: "failed", unchecked: "pending" } as const;

function seconds(ms: number | null): string {
  if (ms === null) return "";
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function Link({ link }: { link: CloudCheckLink }) {
  // A machine that started says only where, which the row above already does.
  const words = link.state === "running" || (link.step === "machine" && link.state === "ok") ? null : link.words;
  return (
    <li data-state={MARKS[link.state]}>
      <StepMark state={MARKS[link.state]} />
      <span className="cloud-check-step">
        <span>{LINKS[link.step]}</span>
        {words && link.state !== "broken" ? <span className="cloud-check-detail">{words}</span> : null}
        {words && link.state === "broken" ? (
          <span role="alert" className="cloud-check-error">
            {words}
          </span>
        ) : null}
      </span>
      <span className="cloud-check-time">{link.state === "ok" || link.state === "broken" ? seconds(link.ms) : ""}</span>
    </li>
  );
}

/** The row's own words: what the last check found, or that none has run. */
function verdict(check: CloudCheck | null): string {
  if (!check) return "Not run yet";
  if (!check.done) return "Checking";
  return check.broken ? `Broken: ${LINKS[check.broken]}` : "Everything works";
}

/**
 * Every link a cloud turn needs, tried side by side, the broken one named with why: this server, the person's Pro and
 * hours, each agent's sign-in, GitHub in the space they are in, and a free test machine on their service. Absent where
 * the server runs no check.
 */
export function CloudCheckSection({ active }: { active: boolean }) {
  const read = useRpc(
    "cloudCheck.read",
    {},
    { enabled: active, refetchInterval: (query) => (active && query.state.data?.state === "ready" && query.state.data.check && !query.state.data.check.done ? RUNNING_MS : false) },
  );
  const start = useRpcMutation("cloudCheck.start");
  // With Personal alone the space switcher has nothing to hold, so Personal is read from the account's spaces.
  const status = useRpc("spaces.status", {}, { enabled: active });
  const navigated = useSpaceNavigation((state) => state.current ?? state.personal);
  const space = navigated ?? (status.data?.state === "ready" ? status.data.personalSpaceId : null);
  if (read.error) return <Failure error={read.error} />;
  if (read.data?.state !== "ready") return null;
  const { check } = read.data;
  const running = check !== null && !check.done;
  return (
    <Section title="Check">
      <SettingRow label={verdict(check)} hint={check ? `On ${check.service}` : undefined}>
        <Button
          disabled={running || start.isPending || !space}
          onClick={() => space && start.mutate({ spaceId: space }, { onSuccess: (state) => queryClient.setQueryData(["cloudCheck.read", {}], state) })}
        >
          {check ? "Run again" : "Run check"}
        </Button>
      </SettingRow>
      {check ? (
        <ol className="cloud-check-steps" aria-label="Cloud check">
          {check.links.map((link) => (
            <Link key={link.step} link={link} />
          ))}
        </ol>
      ) : null}
      <Failure error={start.error} />
    </Section>
  );
}
