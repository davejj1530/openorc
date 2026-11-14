import { personFirst, personName } from "@openorc/client";
import type { ThreadPerson } from "@openorc/protocol";
import "../styles/together.css";
import { AccountFace } from "./AccountFace";
import { Button } from "./ui";

/** Who sent a turn, beside its agent: a face and a first name, the whole name on demand. A former member has no face. */
export function TurnSender({ person }: { person: ThreadPerson | null }) {
  const first = personFirst(person);
  const whole = personName(person);
  return (
    <span className="turn-head-sender" data-tip={whole !== first ? whole : undefined}>
      {person ? <AccountFace name={whole} image={person.image} /> : null}
      {first}
    </span>
  );
}

/** Who wrote a person's message in a thread others are in, above it: a face and their name. */
export function PromptAuthor({ person }: { person: ThreadPerson | null }) {
  const name = personName(person);
  return (
    <div className="prompt-author">
      {person ? <AccountFace name={name} image={person.image} /> : null}
      <span className="prompt-author-name">{name}</span>
    </div>
  );
}

/** Who wrote a message waiting in the queue, above its words. */
export function QueueAuthor({ person }: { person: ThreadPerson | null }) {
  const name = personName(person);
  return (
    <span className="queue-author">
      {person ? <AccountFace name={name} image={person.image} /> : null}
      <span className="prompt-author-name">{name}</span>
    </span>
  );
}

/** The card above the composer when who sent each turn could not be read: the names stay off until a read works. */
export function VoicesFailed({ onRetry }: { onRetry: () => void }) {
  return (
    <section role="status" aria-label="OpenOrc Cloud" data-plane className="flex flex-wrap items-center justify-between gap-x-3 rounded-xl bg-surface px-3.5 py-1.5 text-base">
      <div className="py-1.5 text-ink">Couldn't read who sent each turn.</div>
      <Button variant="secondary" onClick={onRetry}>
        Try again
      </Button>
    </section>
  );
}
