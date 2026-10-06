/**
 * Marks the outline link of the section being read: the last section whose heading
 * has passed the line where a heading lands after following its link.
 */
const links = [...document.querySelectorAll<HTMLAnchorElement>(".docs-toc a[href^='#']")];
const headings = links.map((link) => document.getElementById(decodeURIComponent(link.hash.slice(1))));

if (links.length) {
  let frame = 0;
  const update = () => {
    frame = 0;
    const line = (parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop) || 100) + 1;
    let current = 0;
    headings.forEach((heading, i) => {
      if (heading && heading.getBoundingClientRect().top <= line) current = i;
    });
    // Near the end the last sections can no longer reach the line, so the last one counts as read.
    if (innerHeight + scrollY >= document.documentElement.scrollHeight - 2) current = links.length - 1;
    links.forEach((link, i) => {
      if (i === current) link.setAttribute("aria-current", "location");
      else link.removeAttribute("aria-current");
    });
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(update);
  };
  addEventListener("scroll", schedule, { passive: true });
  addEventListener("resize", schedule);
  update();
}
