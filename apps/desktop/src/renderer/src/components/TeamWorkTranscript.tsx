import type { ComponentProps } from "react";
import { WorkTranscript } from "./Transcript";

/** Team turns share the thread's work disclosure, retaining ambient-read suppression. */
export function TeamWorkTranscript(props: ComponentProps<typeof WorkTranscript>) {
  return <WorkTranscript {...props} taskCards={false} />;
}
