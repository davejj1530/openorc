/** The production file panel with an in-memory disk, for reviewing its layout without touching project files. */
import { createRoot } from "react-dom/client";
import { useState, useSyncExternalStore, type ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { fileRpcParams, type Project, type RpcMethod } from "../../packages/protocol/src/index";
import { fakeFileDisk } from "../../apps/desktop/src/renderer/src/fixtures/file-disk";

Object.assign(window, {
  openorc: {
    platform: "linux",
    onTheme: () => () => {},
    setTheme() {},
    browser: { setContext() {}, onReveal: () => () => {}, close() {}, navigate() {} },
  },
});

function onResize(notify: () => void) {
  window.addEventListener("resize", notify);
  return () => window.removeEventListener("resize", notify);
}

function PreviewFrame({ children, theme }: { children: ReactNode; theme: (value: "light" | "dark") => void }) {
  const viewport = useSyncExternalStore(onResize, () => window.innerWidth);
  const [narrow, setNarrow] = useState(false);
  const fullWidth = new URLSearchParams(location.search).get("width") === "1000" ? 1000 : viewport;
  const width = narrow ? 420 : fullWidth;
  return (
    <div className="app-shell" style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", gap: 16, alignItems: "center", justifyContent: "flex-end", padding: "8px 16px", borderBottom: "1px solid var(--line)", fontSize: 12 }}>
        <button onClick={() => theme("light")}>Light</button>
        <button onClick={() => theme("dark")}>Dark</button>
        <button onClick={() => setNarrow(!narrow)}>Toggle narrow</button>
      </div>
      <div id="file-preview-frame" style={{ position: "relative", flex: 1, minHeight: 0, width, zoom: Math.min(1, viewport / width), alignSelf: "center" }}>
        {children}
      </div>
    </div>
  );
}

async function main() {
  const [{ Panel }, { core }, { queryClient }, { useLayout }, { usePanelSessions }, { useTheme }, { useDrafts }] = await Promise.all([
    import("../../apps/desktop/src/renderer/src/components/Panel"),
    import("../../apps/desktop/src/renderer/src/lib/rpc"),
    import("../../apps/desktop/src/renderer/src/lib/client"),
    import("../../apps/desktop/src/renderer/src/lib/layout"),
    import("../../apps/desktop/src/renderer/src/lib/panel-tabs"),
    import("../../apps/desktop/src/renderer/src/lib/theme"),
    import("../../apps/desktop/src/renderer/src/lib/file-drafts"),
  ]);
  const disk = fakeFileDisk();
  disk.set(
    "src/components/FileViewer.tsx",
    `import { useState } from "react";
import { FileTree } from "./FileTree";

export function FileViewer() {
  const [selected, select] = useState("README.md");

  return (
    <section className="file-viewer">
      <Editor path={selected} />
      <FileTree selected={selected} onSelect={select} />
    </section>
  );
}
`,
  );
  disk.set("src/components/FileTree.tsx", 'export function FileTree() {\n  return <nav aria-label="Project files" />;\n}\n');
  disk.set("src/app.tsx", "export { FileViewer as App } from './components/FileViewer';\n");
  disk.set("src/styles/app.css", ".file-viewer { display: flex; height: 100%; }\n");
  disk.set("packages/core/index.ts", "export const version = '1.0.0';\n");
  disk.set(".github/workflows/ci.yml", "name: CI\non: [push]\n");
  disk.set(".git/HEAD", "ref: refs/heads/main\n");
  disk.set("node_modules/react/index.js", "export {};\n");
  disk.set(".DS_Store", "metadata");
  disk.set("dist/index.js", "// Generated output\n");
  for (const path of [".git", "node_modules", ".DS_Store", "dist"]) disk.ignored.add(path);
  disk.set(".gitignore", "node_modules\ndist\n");
  disk.set(".gitattributes", "# Keep text files consistent\n* text=auto eol=lf\n");
  disk.set("README.md", "# OpenOrc\n\nA desktop workspace for your coding agents.\n\n## Files\n\nBrowse the project tree and keep your editor beside the conversation.\n");
  disk.set("package.json", '{\n  "name": "openorc",\n  "private": true\n}\n');
  Object.assign(core, {
    call: async (method: RpcMethod, params: unknown) => {
      if (method === "files.list") return disk.list(fileRpcParams[method].parse(params).path);
      if (method === "files.read") return disk.read(fileRpcParams[method].parse(params).path);
      if (method === "files.write") return disk.write(fileRpcParams[method].parse(params));
      if (method === "files.search") {
        const { query } = fileRpcParams[method].parse(params);
        return [...disk.files.keys()].filter((path) => path.toLowerCase().includes(query.toLowerCase()));
      }
      return [];
    },
  });
  const project: Project = {
    id: "explorer-preview",
    name: "openorc",
    rootPath: "/repo",
    gitRemote: null,
    defaultBranch: "main",
    settings: { setupScript: null, worktreeInclude: [], branchPrefix: "openorc", detectedConfigs: [] },
    createdAt: 0,
    updatedAt: 0,
  };
  useDrafts.setState({ keys: new Set(), ready: true, loaded: new Map(), failed: false });
  const params = new URLSearchParams(location.search);
  useTheme.getState().set(params.get("theme") === "light" ? "light" : "dark");
  useLayout.setState({ panelOpen: true, panelExpanded: true, sidebarOpen: true, panelRequest: null });
  usePanelSessions.setState({ sessions: {} });
  usePanelSessions.getState().open("project:explorer-preview", { kind: "file", selection: null });
  usePanelSessions.getState().open("project:explorer-preview", { kind: "file", selection: { scope: { kind: "project", id: project.id }, path: "src/components/FileViewer.tsx" } });
  const mount = document.getElementById("root");
  if (!mount) throw new Error("Preview root is missing");
  createRoot(mount).render(
    <QueryClientProvider client={queryClient}>
      <PreviewFrame theme={(value) => useTheme.getState().set(value)}>
        <Panel context={{ kind: "project", project }} />
      </PreviewFrame>
    </QueryClientProvider>,
  );
}

void main();
