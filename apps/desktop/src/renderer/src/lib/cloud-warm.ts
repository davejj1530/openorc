import { useEffect, useRef } from "react";
import { harnessIds, type HarnessId } from "@openorc/protocol";
import { useRpcMutation } from "./client";

/** How often a draft still being written asks again, which keeps the sandbox made for it waiting. */
const AGAIN_MS = 60_000;

/**
 * While the first message of a new cloud thread is written, the place it starts gets ready ahead: asked at the first
 * keystroke, then at most once a minute while typing goes on. A draft nobody types in, or one opened again, asks nothing.
 */
export function useCloudWarm(projectId: string | null, agent: string | undefined, prompt: string): void {
  const warm = useRpcMutation("cloud.warm");
  const asked = useRef<{ key: string; at: number } | null>(null);
  // A draft opened again, written before, is not being typed.
  const opened = useRef(prompt);
  useEffect(() => {
    if (!projectId || !harnessIds.includes(agent as HarnessId) || !prompt.trim() || prompt === opened.current) return;
    const key = `${projectId}:${agent}`;
    if (asked.current?.key === key && Date.now() - asked.current.at < AGAIN_MS) return;
    asked.current = { key, at: Date.now() };
    warm.mutate({ projectId, agent: agent as HarnessId });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- The mutation is new each render; the clock above decides when to ask.
  }, [projectId, agent, prompt]);
}
