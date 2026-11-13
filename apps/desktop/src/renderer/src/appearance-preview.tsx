import { QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { createAppearancePreviewRpc } from "./lib/appearance-preview-data";
import "./app.css";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => void values.set(key, String(value)),
  };
}

// Imported UI modules may save drafts and preferences. Keep both storage areas local to this frame.
Object.defineProperties(window, { localStorage: { value: memoryStorage() }, sessionStorage: { value: memoryStorage() } });
window.addEventListener("storage", (event) => event.stopImmediatePropagation());
Object.defineProperty(window, "openorc", {
  value: {
    platform: "darwin",
    onTheme: () => () => {},
    setTheme() {},
    openExternal() {},
    openWindow() {},
    assetUrl: (path: string) => path,
    updates: { settings: async () => ({ automaticChecks: false }), getState: async () => ({ state: { phase: "current" }, dismissed: true }), onState: () => () => {} },
  },
});

async function main() {
  const { core } = await import("./lib/rpc");
  core.call = createAppearancePreviewRpc();
  const [{ App }, { queryClient }, { useLayout, limits }, { useRouter }, { useTheme }] = await Promise.all([
    import("./App"),
    import("./lib/client"),
    import("./lib/layout"),
    import("./lib/router"),
    import("./lib/theme"),
  ]);
  queryClient.setDefaultOptions({ queries: { retry: false, staleTime: Infinity, refetchOnWindowFocus: false } });
  useLayout.setState({ sidebarOpen: true, panelOpen: false });
  useLayout.getState().setSidebarWidth(limits.sidebar.default);
  useRouter.getState().navigate({ view: "newthread", projectId: "example" });

  window.addEventListener("message", (event: MessageEvent) => {
    const message = event.data;
    if (event.source !== parent || message?.type !== "openorc:appearance" || !["light", "dark"].includes(message.mode)) return;
    const root = document.documentElement;
    root.dataset.theme = message.mode;
    root.dataset.palette = message.preset;
    root.dataset.font = message.font ?? "immaculate-gothic";
    root.classList.toggle("dark", message.mode === "dark");
    for (const [token, value] of Object.entries(message.colors ?? {})) if (token.startsWith("--") && typeof value === "string") root.style.setProperty(token, value);
    useTheme.setState({ choice: message.mode, resolved: message.mode, preset: message.preset });
  });

  createRoot(document.getElementById("root")!).render(
    <QueryClientProvider client={queryClient}>
      <App />
      <div aria-hidden="true" style={{ position: "fixed", left: 14, top: 13, display: "flex", gap: 9, pointerEvents: "none" }}>
        {["#ff5f57", "#febc2e", "#28c840"].map((background) => (
          <span key={background} style={{ width: 14, height: 14, borderRadius: "50%", background }} />
        ))}
      </div>
    </QueryClientProvider>,
  );
  requestAnimationFrame(() => parent.postMessage({ type: "openorc:appearance-ready" }, "*"));
}

void main();
