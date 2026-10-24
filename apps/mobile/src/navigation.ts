import type { LinkState } from "./connection/manager";

const macOf = (state: LinkState) => (state.kind === "unpaired" ? null : state.mac.id);

/**
 * When the Mac Home shows changes (another Mac picked or paired, this one removed or forgotten), whatever was open
 * belonged to the old Mac: back to Home, which shows the new one or the way to pair.
 */
export function leaveOnMacChange(link: { subscribe(listener: () => void): () => void; getState(): LinkState }, goHome: () => void): () => void {
  let shown = macOf(link.getState());
  return link.subscribe(() => {
    const next = macOf(link.getState());
    if (next === shown) return;
    const had = shown;
    shown = next;
    if (had !== null) goHome();
  });
}
