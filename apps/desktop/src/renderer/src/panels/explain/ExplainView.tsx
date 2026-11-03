import { useEffect } from "react";
import type { CodeExplainResult, ExplanationView, FileScope, FolderPath, LineSpan } from "@openorc/protocol";
import { RichText } from "../../components/RichText";
import { Button, TextButton } from "../../components/ui";
import { explanationKey, useExplanations, type Explanation, type ExplainRequest } from "../../lib/code-explanations";
import { useRouter } from "../../lib/router";
import { DiagramView } from "./DiagramView";
import { WalkthroughView } from "./WalkthroughView";
import "./explain.css";

type Answered = Extract<Explanation, { state: "answered" }>;
type Explained = Answered & { result: Extract<CodeExplainResult, { kind: "explained" }> };

interface Props {
  view: ExplanationView;
  scope: FileScope;
  path: FolderPath;
  /** The file as the editor shows it now. */
  text: string;
  onShowLines: (lines: LineSpan) => void;
}

const fileName = (path: string) => path.split("/").pop() ?? path;
const explained = (entry: Answered | null | undefined): entry is Explained => entry?.result.kind === "explained";

/** What to show while a new explanation is on its way: the last one, unless it was a problem. */
function shown(entry: Explanation | undefined): Answered | null {
  if (!entry) return null;
  if (entry.state === "answered") return entry;
  return explained(entry.previous) ? entry.previous : null;
}

function Waiting({ path }: { path: string }) {
  return (
    <div className="explain-status" role="status">
      <p>Explaining {fileName(path)}…</p>
      <div className="explain-skeleton" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
    </div>
  );
}

function Problem({ result, onRetry }: { result: Exclude<CodeExplainResult, { kind: "explained" }>; onRetry: () => void }) {
  const settings = result.kind === "unavailable" && result.settings;
  return (
    <div className="explain-status" role="status">
      <p>{result.reason}</p>
      {result.kind === "failed" || settings ? (
        <div className="explain-status-actions">
          {settings ? (
            <Button size="sm" onClick={() => useRouter.getState().navigate({ view: "settings", section: "memory" })}>
              Open Settings
            </Button>
          ) : null}
          <Button size="sm" variant={settings ? "ghost" : undefined} onClick={onRetry}>
            Try again
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** Who wrote the explanation, or that the file has changed since, and a way to ask again. */
function Bar({ entry, text, onRefresh }: { entry: Explanation; text: string; onRefresh: () => void }) {
  const answer = shown(entry);
  if (!explained(answer)) return null;
  const explaining = entry.state === "explaining";
  let note = `Explained by ${answer.result.model.label}`;
  if (explaining) note = "Explaining again…";
  else if (answer.text !== text) note = "The file changed since it was explained.";
  return (
    <div className="explain-bar" data-stale={(!explaining && answer.text !== text) || undefined}>
      <span role="status">{note}</span>
      {explaining ? null : (
        <TextButton tone="muted" onClick={onRefresh}>
          Explain again
        </TextButton>
      )}
    </div>
  );
}

function Body({ answer, request, onRetry, onShowLines }: { answer: Answered; request: ExplainRequest; onRetry: () => void; onShowLines: (lines: LineSpan) => void }) {
  if (answer.result.kind !== "explained") return <Problem result={answer.result} onRetry={onRetry} />;
  const { explanation } = answer.result;
  if (explanation.view === "english")
    return (
      <div className="explain-scroll">
        <div className="explain-prose prose-chat">
          <RichText mode="static">{explanation.markdown}</RichText>
        </div>
      </div>
    );
  if (explanation.view === "walkthrough") return <WalkthroughView explanation={explanation} text={answer.text} path={request.path} scope={request.scope} onShowLines={onShowLines} />;
  return <DiagramView diagram={explanation} onShowLines={onShowLines} />;
}

/** A code file explained one of three ways. Opening a view asks once; asking again is the reader's choice. */
export function ExplainView({ view, scope, path, text, onShowLines }: Props) {
  const request: ExplainRequest = { scope, path, view, text };
  const entry = useExplanations((state) => state.entries[explanationKey(request)]);
  useEffect(() => useExplanations.getState().ensure({ scope, path, view, text }), [scope, path, view, text]);
  const answer = shown(entry);
  const refresh = () => useExplanations.getState().refresh(request);
  return (
    <div className="explain-view" data-view={view}>
      {entry ? <Bar entry={entry} text={text} onRefresh={refresh} /> : null}
      {answer ? <Body answer={answer} request={request} onRetry={refresh} onShowLines={onShowLines} /> : <Waiting path={path} />}
    </div>
  );
}
