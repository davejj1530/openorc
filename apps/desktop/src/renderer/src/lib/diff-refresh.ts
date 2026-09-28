import { invalidateTags } from "./query";

/**
 * Working-tree diffs are not polled. The core refreshes the ones an agent's changes can reach; files that change
 * outside a turn are read again when the window regains focus, and after a command typed into a terminal finishes.
 */
export function installDiffRefresh(): void {
  window.addEventListener("focus", () => invalidateTags(["workspace-diff"], { immediate: true }));
  window.openorc.terminal.onSettled(() => invalidateTags(["workspace-diff"]));
}
