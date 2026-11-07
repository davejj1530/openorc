/** The production file panel, speaking to the disposable real core in editor-intelligence-preview.mts. */
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { CorePush, type Project, type RpcMethod } from "../../packages/protocol/src/index";

Object.assign(window, { openorc: { platform: "linux", connectBridge() {}, onTheme: () => () => {}, setTheme() {}, browser: { setContext() {}, onReveal: () => () => {}, close() {} } } });
const { core } = await import("../../apps/desktop/src/renderer/src/lib/rpc");
const listeners = new Set<(value: { type: "invalidate"; keys: string[] }) => void>();
let nextId = 0;
Object.assign(core, {
  call: async (method: RpcMethod, params: unknown) => {
    const response = await fetch("/rpc", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "rpc", id: ++nextId, method, params }) });
    const reply = CorePush.parse(await response.json());
    if (reply.type === "rpc.error") throw new Error(reply.message);
    if (reply.type !== "rpc.result") throw new Error("Expected a fixture RPC result");
    return reply.result;
  },
  onPush: (listener: (value: { type: "invalidate"; keys: string[] }) => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
});
const events = new EventSource("/events");
events.onmessage = (event) => {
  const push = CorePush.parse(JSON.parse(event.data));
  if (push.type === "invalidate") for (const listener of listeners) listener(push);
};
const fixture: { project: Project; folder: string } = await (await fetch("/fixture")).json();
const [{ FilePanel }, { useLayout }, { queryClient }, { useTheme }, { useDrafts, fileKey }, { useFileExplorer }] = await Promise.all([
  import("../../apps/desktop/src/renderer/src/panels/FilePanel"),
  import("../../apps/desktop/src/renderer/src/lib/layout"),
  import("../../apps/desktop/src/renderer/src/lib/client"),
  import("../../apps/desktop/src/renderer/src/lib/theme"),
  import("../../apps/desktop/src/renderer/src/lib/file-drafts"),
  import("../../apps/desktop/src/renderer/src/lib/file-explorer"),
]);
const scope = { kind: "project", id: fixture.project.id } as const;
const openAt = async (path: string, needle = "", offset = 0) => {
  const file = await core.call("files.read", { scope, path });
  if (file.kind !== "file") throw new Error("Expected a fixture text file");
  const draft = useDrafts.getState().loaded.get(fileKey(file));
  const text = draft?.text ?? file.text;
  const position = Math.max(0, text.indexOf(needle)) + offset;
  const before = text.slice(0, position).split("\n");
  const line = before.length;
  const column = (before.at(-1)?.length ?? 0) + 1;
  useLayout.getState().openFile({ scope, path, line, column, endLine: line, endColumn: column });
};
useDrafts.setState({ keys: new Set(), ready: true, loaded: new Map(), failed: false });
useFileExplorer.getState().setVisible(false);
const params = new URLSearchParams(location.search);
useTheme.getState().set(params.get("theme") === "dark" ? "dark" : "light");
await openAt("main.ts", "double(2)", 2);
Object.assign(window, {
  editorQA: {
    openAt,
    theme: (mode: "light" | "dark") => useTheme.getState().set(mode),
    palette: useTheme.getState().setPreset,
    snapshot: () => ({ selected: useLayout.getState().selectedFile, dirty: [...useDrafts.getState().loaded].filter(([, draft]) => draft).map(([key, draft]) => ({ key, text: draft?.text })) }),
  },
});
function Fixture() {
  const selected = useLayout((state) => state.selectedFile);
  return (
    <div className="app-shell" style={{ height: "100vh", padding: 12 }}>
      <div data-plane style={{ height: "100%", borderRadius: 20, overflow: "hidden", background: "var(--surface)" }}>
        {selected ? <FilePanel selection={selected} directory={fixture.folder} /> : null}
      </div>
    </div>
  );
}
const mount = document.getElementById("root");
if (!mount) throw new Error("Missing fixture root");
createRoot(mount).render(
  <QueryClientProvider client={queryClient}>
    <Fixture />
  </QueryClientProvider>,
);
