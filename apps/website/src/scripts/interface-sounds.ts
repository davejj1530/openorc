import { isSound, type Sound } from "./sounds";
import { play } from "./speaker";

/*
 * Every interaction on the site makes a sound, by pointer or by keyboard. A control can name its own in data-sound;
 * otherwise links and buttons click, tabs tap, and a disclosure says on as it opens and off as it closes.
 */

const keys = new Set(["ArrowLeft", "ArrowRight", "Home", "End"]);

function soundFor(target: Element): Sound | null {
  const named = target.closest<HTMLElement>("[data-sound]")?.dataset.sound;
  if (named) return named === "none" || !isSound(named) ? null : named;
  const summary = target.closest("summary");
  if (summary) return summary.parentElement?.hasAttribute("open") ? "off" : "on";
  if (target.closest('[role="tab"]')) return "tap";
  if (target.closest("a[href], button, label")) return "click";
  return null;
}

addEventListener(
  "click",
  (event) => {
    const sound = event.target instanceof Element ? soundFor(event.target) : null;
    if (sound) play(sound);
  },
  { capture: true },
);

addEventListener("keydown", (event) => {
  if (keys.has(event.key) && event.target instanceof Element && event.target.closest('[role="tab"]')) play("tap");
});
