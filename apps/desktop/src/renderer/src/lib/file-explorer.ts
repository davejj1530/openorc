import { create } from "zustand";
import { persist } from "zustand/middleware";

interface ExplorerState {
  visible: boolean;
  showIgnored: boolean;
  width: number;
  folders: Record<string, string[]>;
  setVisible: (visible: boolean) => void;
  setShowIgnored: (showIgnored: boolean) => void;
  setWidth: (width: number) => void;
  setFolders: (scope: string, folders: string[]) => void;
  reveal: (scope: string, path: string) => void;
}

export const explorerWidth = { min: 180, max: 360, default: 240 };
export const clampExplorerWidth = (width: number) => Math.max(explorerWidth.min, Math.min(explorerWidth.max, width));
export const ROOT_FOLDERS = [""];

/** Tree expansion belongs to a file scope; sidebar size and visibility follow the user between conversations. */
export const useFileExplorer = create<ExplorerState>()(
  persist(
    (set, get) => ({
      visible: true,
      showIgnored: false,
      width: explorerWidth.default,
      folders: {},
      setVisible: (visible) => set({ visible }),
      setShowIgnored: (showIgnored) => set({ showIgnored }),
      setWidth: (width) => set({ width: clampExplorerWidth(width) }),
      setFolders: (scope, folders) => {
        const kept = Object.entries(get().folders)
          .filter(([key]) => key !== scope)
          .slice(-99);
        set({ folders: Object.fromEntries([...kept, [scope, folders]]) });
      },
      reveal: (scope, path) => {
        const parents = path
          .split("/")
          .slice(0, -1)
          .map((_, index, parts) => parts.slice(0, index + 1).join("/"));
        get().setFolders(scope, [...new Set([...(get().folders[scope] ?? ROOT_FOLDERS), "", ...parents])]);
      },
    }),
    { name: "openorc.file-explorer", version: 1, partialize: ({ visible, showIgnored, width, folders }) => ({ visible, showIgnored, width, folders }) },
  ),
);

export function relativeFilePath(path: string, root: string): string {
  const file = path.replaceAll("\\", "/");
  const prefix = root.replaceAll("\\", "/").replace(/\/$/, "") + "/";
  return file.startsWith(prefix) ? file.slice(prefix.length) : file;
}
