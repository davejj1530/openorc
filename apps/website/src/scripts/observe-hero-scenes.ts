/** Lazy scene players share one visibility and import-failure owner. */
export function observeHeroScenes(selector: string) {
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting || !(entry.target instanceof HTMLElement)) continue;
        observer.unobserve(entry.target);
        void startScene(entry.target);
      }
    },
    { threshold: 0.05 },
  );
  document.querySelectorAll<HTMLElement>(selector).forEach((scene) => observer.observe(scene));
}

async function startScene(scene: HTMLElement) {
  try {
    const { initHeroScene } = await import("./hero-scene");
    initHeroScene(scene);
  } catch (error) {
    // Keep the server-rendered first moment visible when the player cannot load.
    console.error("Unable to start the sample scene", error);
  }
}
