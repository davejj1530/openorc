import { useEffect, useRef } from "react";
import type { OrclingLook } from "@openorc/protocol";
import { cn } from "../lib/cn";
import { useCanvasAnimation } from "./canvas-animation";
import { OrclingStill } from "./OrclingAvatar";
import type { OrclingExpression } from "./orcling-runtime";
import "./RiveMascot.css";

/** The flat drawing's body fills 76% of its box; the Rive body fills 60% of the artboard. */
const STILL_SCALE = 0.6 / 0.76;

const loadOrclingRuntime = () => import("./orcling-runtime").then((runtime) => runtime.createOrclingAnimation);

/** An Orcling alive on a canvas, over its still drawing, which shows under reduced motion or when Rive cannot load. */
export function OrclingPreview({ look, expression = 0, size, className }: { look: OrclingLook; expression?: OrclingExpression; size: number; className?: string }) {
  const frame = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const { ready, animation } = useCanvasAnimation({ frame, canvas, loadRuntime: loadOrclingRuntime });

  useEffect(() => {
    animation.current?.setLook(look);
  }, [animation, look, ready]);
  useEffect(() => {
    animation.current?.express(expression);
  }, [animation, expression, ready]);

  return (
    <div ref={frame} className={cn("rive-mascot orcling-preview", className)} style={{ width: size, height: size }} aria-hidden="true" data-ready={ready}>
      {/* The still sits where the Rive body does: the central 60% of the artboard, a little above center. */}
      <div className="rive-mascot-static orcling-preview-still">
        <OrclingStill look={look} size={Math.round(size * STILL_SCALE)} />
      </div>
      <canvas ref={canvas} className="rive-mascot-canvas" />
    </div>
  );
}
