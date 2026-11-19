import { ScrollView } from "react-native";
import { Prompt } from "../thread/messages";
import { ActivityRow } from "../thread/tools";

/** A first message on its way to OpenOrc Cloud: what New thread shows from Start until the thread is there to open. */
export interface CloudStart {
  text: string;
  attachments: string[];
  at: number;
}

/**
 * A cloud start as the thread it is becoming, as the desktop shows it: the message as sent, and the start's step under
 * it, until the server holds the thread and it opens with its own steps. A start that fails gives the composer back
 * with its words and the draft.
 */
export function NewThreadStarting({ start }: { start: CloudStart }) {
  return (
    <ScrollView accessibilityState={{ busy: true }} className="flex-1 bg-bg" contentContainerClassName="gap-4 px-3 pt-4">
      <Prompt
        block={{
          id: "start-message",
          kind: "message",
          role: "user",
          text: start.text,
          streaming: false,
          pending: true,
          at: start.at,
          ...(start.attachments.length ? { attachments: start.attachments } : {}),
        }}
      />
      <ActivityRow block={{ id: "start-thread", kind: "activity", label: "Starting the thread", status: "running", text: "", at: start.at }} runId="new-thread" />
    </ScrollView>
  );
}
