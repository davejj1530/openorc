import { threadMarkMotion, type ThreadMarkKind } from "../../../../packages/client/src/state-marks";

/**
 * Plays every moving state mark on the page as the app does: each dot runs its own loop, and all marks of a kind keep
 * the same time. A mark in a scene that is at rest holds still with it. Reduced motion leaves every mark on the
 * moment it was drawn at.
 */
export function playStateMarks() {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const byScene = new Map<Element, Animation[]>();
  for (const mark of document.querySelectorAll<SVGSVGElement>("svg[data-state-mark]:not([data-playing])")) {
    mark.dataset.playing = "";
    const motion = threadMarkMotion(mark.dataset.stateMark as ThreadMarkKind);
    const plays = Array.from(mark.children, (dot, index) => {
      const frames = motion.dots[index]!.frames;
      const play = dot.animate(
        [...frames, frames[0]!].map((frame) => ({ transform: `scale(${frame.size})`, "--hs-mark-wear": frame.ramp })),
        { duration: motion.period, iterations: Infinity },
      );
      play.startTime = 0;
      return play;
    });
    const scene = mark.closest("[data-hero-scene]");
    if (scene) byScene.set(scene, [...(byScene.get(scene) ?? []), ...plays]);
  }
  for (const [scene, plays] of byScene) {
    const follow = () => {
      for (const play of plays) {
        if (scene.hasAttribute("data-paused")) play.pause();
        else play.startTime = 0;
      }
    };
    follow();
    new MutationObserver(follow).observe(scene, { attributes: true, attributeFilter: ["data-paused"] });
  }
}
