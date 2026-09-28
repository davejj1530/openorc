import { lazy, Suspense, useEffect, useState } from "react";
import { useReducedMotion } from "../lib/motion";
import { Sparkles } from "./icons";

/**
 * Big enough that the shader is an object rather than a glyph. It sits alone
 * at the tail of the conversation, not in the transcript's 13px icon column,
 * so it is sized to be looked at. The approved original Hollow shader lives
 * under components/orbs/hollow; see components/orbs/README.md.
 */
const SIZE = 36;

/** Resting or working. The variant ships a preset per state and the renderer springs between them. */
export type OrbState = "idle" | "thinking";

/**
 * The shader, its runtime and typegpu are a chunk of their own, so nothing
 * loads until a conversation is on screen. A chunk that fails to arrive falls
 * back to the glyph rather than throwing into the conversation.
 *
 * Hollow keeps its own pearl and silver material, with light escaping through
 * the shell. Its appearance is independent of the workspace palette.
 */
const LazyOrb = lazy(async () => {
  try {
    const { HollowOrb } = await import("./orbs/hollow");
    return { default: ({ state }: { state: OrbState }) => <HollowOrb size={SIZE} state={state} /> };
  } catch (error) {
    console.error("[orb] the shader chunk did not load", error);
    return { default: () => <Glyph /> };
  }
});

/** A machine can expose `navigator.gpu` and still refuse an adapter. Asked once, for the whole app. */
let adapter: Promise<boolean> | undefined;
function hasAdapter(): Promise<boolean> {
  return (adapter ??= (async () => {
    if (!("gpu" in navigator)) return false;
    try {
      return Boolean(await navigator.gpu.requestAdapter());
    } catch {
      return false;
    }
  })());
}

const Glyph = () => <Sparkles size={16} className="tool-icon" data-tone="think" />;

/**
 * The agent itself, at the tail of the conversation: a WebGPU orb where the
 * machine has one, the still glyph everywhere else. It stays between turns and
 * only changes state, so the conversation never loses the thing that stands
 * for whoever is on the other end. The slot is one size either way, so nothing
 * moves when the orb arrives, settles, or fails to load at all.
 *
 * Reduced motion keeps the glyph. Workspace content has no decorative
 * animation under that preference, and a shader running its own frame loop is
 * exactly what it asks the app not to run.
 */
export function AgentOrb({ state }: { state: OrbState }) {
  const reducedMotion = useReducedMotion();
  const [gpu, setGpu] = useState(false);

  useEffect(() => {
    let current = true;
    void hasAdapter().then((ok) => {
      if (current) setGpu(ok);
    });
    return () => {
      current = false;
    };
  }, []);

  return (
    <span className="agent-orb" data-state={state} aria-hidden="true">
      {gpu && !reducedMotion ? (
        <Suspense fallback={<Glyph />}>
          <LazyOrb state={state} />
        </Suspense>
      ) : (
        <Glyph />
      )}
    </span>
  );
}
