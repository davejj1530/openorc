import { useEffect, useRef } from "react";
import { useCanvasAnimation } from "./canvas-animation";
import { MascotStill } from "./MascotStill";
import type { MascotReaction } from "./mascot-runtime";
import "./RiveMascot.css";

const loadMascotRuntime = () => import("./mascot-runtime").then((runtime) => runtime.createMascotAnimation);

interface RiveMascotProps {
  reaction?: MascotReaction;
  reactionKey?: string | number;
  className?: string;
  placement?: "composer" | "hero";
}

export function RiveMascot({ reaction, reactionKey, className = "", placement }: RiveMascotProps) {
  const frame = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const { ready, animation } = useCanvasAnimation({ frame, canvas, loadRuntime: loadMascotRuntime });

  // A new reactionKey replays the same reaction.
  useEffect(() => {
    if (ready && reaction) animation.current?.react(reaction);
  }, [animation, reaction, reactionKey, ready]);

  return (
    <div ref={frame} className={`rive-mascot ${className}`} aria-hidden="true" data-ready={ready} data-placement={placement}>
      <MascotStill className="rive-mascot-static" />
      <canvas ref={canvas} className="rive-mascot-canvas" />
    </div>
  );
}
