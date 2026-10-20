/*
 * Blocks marked data-reveal arrive as they reach the screen (global.css). Whatever is already on screen counts as
 * arrived before the page hides anything, so nothing above the fold flickers; under reduced motion nothing waits.
 */
const blocks = [...document.querySelectorAll<HTMLElement>("[data-reveal]")];
const still = matchMedia("(prefers-reduced-motion: reduce)").matches;

if (!still && blocks.length > 0 && "IntersectionObserver" in window) {
  const show = (block: Element) => block.setAttribute("data-shown", "");
  for (const block of blocks) if (block.getBoundingClientRect().top < innerHeight) show(block);
  document.documentElement.setAttribute("data-reveal-ready", "");
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        show(entry.target);
        observer.unobserve(entry.target);
      }
    },
    { rootMargin: "0px 0px -8% 0px" },
  );
  for (const block of blocks) if (!block.hasAttribute("data-shown")) observer.observe(block);
}
