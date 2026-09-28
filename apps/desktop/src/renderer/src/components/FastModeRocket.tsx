import { useRef } from "react";
import rocketSvg from "../../../../../../assets/fast-mode/fast-mode-rocket.svg?raw";
import { useCanvasAnimation } from "./canvas-animation";
import "./FastModeRocket.css";

// Trusted local artwork is shared by the Rive asset and static fallback.
const themedSvg = rocketSvg.replaceAll("#6E6ADE", "currentColor");

const loadRocketRuntime = () => import("./rocket-runtime").then((runtime) => runtime.createRocketAnimation);

export function FastModeRocket() {
  const frame = useRef<HTMLSpanElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const { ready } = useCanvasAnimation({ frame, canvas, loadRuntime: loadRocketRuntime });

  return (
    <span ref={frame} className="fast-mode-rocket" aria-hidden="true" data-ready={ready}>
      <span className="fast-mode-rocket-static" dangerouslySetInnerHTML={{ __html: themedSvg }} />
      <canvas ref={canvas} className="fast-mode-rocket-canvas" />
    </span>
  );
}
