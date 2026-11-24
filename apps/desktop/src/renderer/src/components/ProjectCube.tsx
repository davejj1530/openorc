import { PROJECT_CUBE, type ProjectActivity } from "@openorc/client";
import "../styles/state-marks.css";

/**
 * A project's mark where it has no image of its own: the OpenOrc cube as an open frame, the place its threads' cubes
 * live in. Its top face fills while its threads work and wears the attention colour when one needs the person. It is
 * decoration: its label names the project and counts what waits.
 */
export function ProjectCube({ activity = "quiet", size = 16 }: { activity?: ProjectActivity | undefined; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" data-activity={activity} className="project-cube">
      <path className="project-cube-top" d={PROJECT_CUBE.top} />
      <path d={PROJECT_CUBE.frame} />
      <path d={PROJECT_CUBE.seams} />
    </svg>
  );
}
