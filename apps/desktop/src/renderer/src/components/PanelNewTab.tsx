import { Globe } from "./icons";
import { pageHost, panelTools, tabsFor, type PanelContext } from "./panel-tools";
import type { PanelTab } from "../lib/layout";

/** A blank tab's page: every tool this context offers, in launcher order, then the pages visited lately. */
export function PanelNewTab({ context, onTool, onNavigate, recentUrls }: { context: PanelContext; onTool: (tool: PanelTab) => void; onNavigate: (url: string) => void; recentUrls: string[] }) {
  return (
    <div className="panel-new-tab">
      <section aria-labelledby="panel-tools-heading">
        <h2 id="panel-tools-heading">Tools</h2>
        <div className="panel-tool-grid">
          {tabsFor(context).map((tool) => {
            const { icon: Icon, label } = panelTools[tool];
            return (
              <button key={tool} className="panel-tool-shortcut" onClick={() => onTool(tool)}>
                <Icon size={15} />
                <span>{label}</span>
              </button>
            );
          })}
        </div>
      </section>
      {recentUrls.length > 0 ? (
        <section aria-labelledby="panel-recent-heading">
          <h2 id="panel-recent-heading">Recent pages</h2>
          <div className="panel-tool-grid">
            {recentUrls.map((url) => (
              <button key={url} className="panel-recent-page" title={url} onClick={() => onNavigate(url)}>
                <Globe size={15} />
                <span>{pageHost(url)}</span>
              </button>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
