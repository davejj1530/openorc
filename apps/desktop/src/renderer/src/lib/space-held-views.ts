import type { SpaceInventory } from "./space-view";

/**
 * What a person had open in an organization that is closed to them. A closed organization lists nothing a view can be
 * checked against, so its view is kept as it was, neither checked nor saved over, until the organization opens again.
 */
export class HeldSpaceViews {
  readonly #held = new Map<string, unknown>();

  /** Keeps a closing space's view as it stands; a view already held is the one from before it closed, and stays. */
  hold(spaceId: string, view: unknown): void {
    if (view !== undefined && !this.#held.has(spaceId)) this.#held.set(spaceId, view);
  }

  /** The view to check against a space's catalog: the held one once the space is open again, else the one given. */
  take(space: SpaceInventory, view: unknown): unknown {
    if (space.closed || !this.#held.has(space.id)) return view;
    const held = this.#held.get(space.id);
    this.#held.delete(space.id);
    return held;
  }

  clear(): void {
    this.#held.clear();
  }
}
