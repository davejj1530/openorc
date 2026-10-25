import { useRef, useState } from "react";
import type { PushRefusal, RemotePushStatus, RemoteStatus, RpcResults } from "@openorc/protocol";
import { Button } from "../components/ui";
import { cn } from "../lib/cn";
import { queryClient, useRpcMutation } from "../lib/client";
import { Section } from "./settings-shared";

/** Apple names the file it hands out after the key: AuthKey_<KEYID>.p8. */
const KEY_FILE = /^AuthKey_([A-Z0-9]{10})\.p8$/;

/** The last thing tried here, which the line under the key speaks for until the key changes. */
type Attempt = { kind: "misnamed" } | { kind: "failed"; message: string } | ({ kind: "tested" } & RpcResults["remote.push.test"]);

/** Only the sandbox's environment refusal means a key that cannot reach the builds Xcode puts on a phone. */
const refusal = ({ reason, environment }: PushRefusal) =>
  reason === "BadEnvironmentKeyIdInToken" && environment === "sandbox" ? "This key can't reach builds from Xcode. Add a Sandbox key." : `Apple did not accept this key (${reason}).`;

function reached(sent: number, phones: number): string {
  if (phones === 0) return "No phone has notifications on.";
  return sent === 1 ? "Sent to 1 phone." : `Sent to ${sent} phones.`;
}

/** The line under the key: what went wrong just now, else Apple's standing refusal, else what a test reached. */
function keyLine(push: RemotePushStatus, attempt: Attempt | null): { text: string; bad: boolean } | null {
  if (attempt?.kind === "misnamed") return { text: "Choose the AuthKey file from Apple, with its name unchanged.", bad: true };
  if (attempt?.kind === "failed") return { text: attempt.message, bad: true };
  const problem = attempt?.kind === "tested" ? attempt.problem : push.problem;
  if (problem) return { text: refusal(problem), bad: true };
  if (attempt?.kind !== "tested") return null;
  if (attempt.sent === 0 && attempt.failed > 0) return { text: "The test did not go through.", bad: true };
  return { text: reached(attempt.sent, push.phones), bad: false };
}

/** The Apple push key this Mac signs phone alerts with. The key goes to the core once and never comes back out. */
export function PushKey({ push }: { push: RemotePushStatus }) {
  const setKey = useRpcMutation("remote.push.setKey");
  const removeKey = useRpcMutation("remote.push.removeKey");
  const test = useRpcMutation("remote.push.test");
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const busy = setKey.isPending || removeKey.isPending || test.isPending;
  const changed = (next: RemoteStatus) => {
    queryClient.setQueryData(["remote.status", {}], next);
    setAttempt(null);
  };
  const failed = (error: Error) => setAttempt({ kind: "failed", message: error.message });
  const add = async (chosen: File) => {
    const keyId = KEY_FILE.exec(chosen.name)?.[1];
    if (!keyId) return setAttempt({ kind: "misnamed" });
    setKey.mutate({ keyId, pem: await chosen.text() }, { onSuccess: changed, onError: failed });
  };
  const line = keyLine(push, attempt);
  return (
    <Section title="Notifications">
      <div className="settings-field">
        <span>Apple push key</span>
        <div className="flex items-center gap-4">
          <span className="text-ink-3">{push.keyId ? `Key ${push.keyId}` : "Not added"}</span>
          {push.keyId ? (
            <>
              <Button size="sm" disabled={busy} onClick={() => test.mutate({}, { onSuccess: (result) => setAttempt({ kind: "tested", ...result }), onError: failed })}>
                Send a test
              </Button>
              <Button size="sm" disabled={busy} onClick={() => removeKey.mutate({}, { onSuccess: changed, onError: failed })}>
                Remove
              </Button>
            </>
          ) : (
            <Button size="sm" disabled={busy} onClick={() => file.current?.click()}>
              Add key
            </Button>
          )}
        </div>
        <input
          ref={file}
          type="file"
          accept=".p8"
          hidden
          onChange={(event) => {
            const chosen = event.target.files?.[0];
            // Cleared, so choosing the same file again still counts as a change.
            event.target.value = "";
            if (chosen) void add(chosen);
          }}
        />
      </div>
      {line && (
        <p role={line.bad ? "alert" : "status"} className={cn("phone-note", { "text-bad": line.bad, "text-ink-3": !line.bad })}>
          {line.text}
        </p>
      )}
    </Section>
  );
}
