import { StrictMode, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { DocumentEditor, type DocumentEditorHandle } from "../../apps/desktop/src/renderer/src/components/DocumentEditor";
import { core } from "../../apps/desktop/src/renderer/src/lib/rpc";
import { useTheme } from "../../apps/desktop/src/renderer/src/lib/theme";
import "../../apps/desktop/src/renderer/src/app.css";

const fixture = (window as any).editorFixture;
core.call = (method, params) => {
  if (method === "attachments.save") return fixture.save(params);
  throw new Error(`Unexpected RPC: ${method}`);
};
useTheme.getState().set("light");
function App() {
  const [value, setValue] = useState(
    () => localStorage.getItem("editor-smoke-draft") ?? "## Acceptance criteria\n\nDescribe the change, then paste a screenshot.\n\n- [ ] Preserve existing content\n- [ ] Keep images with the task",
  );
  const [key, setKey] = useState(0);
  const [ready, setReady] = useState(true);
  const [result, setResult] = useState("");
  const body = useRef<DocumentEditorHandle>(null);
  const change = (next: string) => {
    localStorage.setItem("editor-smoke-draft", next);
    setValue(next);
  };
  Object.assign(window, {
    editorSmoke: {
      value: () => value,
      load: (next: string) => {
        change(next);
        setKey((v) => v + 1);
      },
      theme: (mode: "light" | "dark") => useTheme.getState().set(mode),
    },
  });
  return (
    <main className="task-workspace bg-surface text-ink" style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
      <div className="task-scroll">
        <article className="task-document">
          <h1 className="document-title">Make task descriptions feel effortless</h1>
          <div className="task-properties">
            <span className="property-chip">Backlog</span>
            <span className="property-chip">OpenOrc</span>
          </div>
          <DocumentEditor key={key} ref={body} value={value} onChange={change} onReadyChange={setReady} />
        </article>
      </div>
      <footer className="document-footer">
        <span role="status">{ready ? "Draft saved locally" : "Images pending"}</span>
        <button onClick={async () => setResult((await body.current?.flush()) ? "Saved" : "Save blocked")}>Save task</button>
        <span>{result}</span>
      </footer>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
