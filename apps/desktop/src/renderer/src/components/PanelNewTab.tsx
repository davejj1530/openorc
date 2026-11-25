import { hostedPanelControl, pageHost } from "@openorc/client";
import { Globe } from "./icons";
import { panelTools, tabsFor, type PanelContext } from "./panel-tools";
import type { PanelTab } from "../lib/layout";
import { useHostedCapabilities } from "../hooks/useHostedCapabilities";
import { HostedControlReason } from "./HostedControlReason";

/**
 * A blank tab's page: every tool this context offers, in launcher order, then the pages visited lately. Each row's
 * glyph is 18px, a size over its name and in the name's own ink, as the sidebar's screens are.
 */
export function PanelNewTab({ context, onTool, onNavigate, recentUrls }: { context: PanelContext; onTool: (tool: PanelTab) => void; onNavigate: (url: string) => void; recentUrls: string[] }) {
  const availability = useHostedCapabilities(context.kind === "thread" ? context.thread : null);
  return (
    <div className="panel-new-tab">
      <section aria-labelledby="panel-tools-heading">
        <h2 id="panel-tools-heading">Tools</h2>
        <div className="panel-tool-grid">
          {tabsFor(context).map((tool) => {
            const { icon: Icon, label } = panelTools[tool];
            const control = tool === "device" ? null : hostedPanelControl(tool);
            const reason = control ? availability.reason(control) : null;
            if (reason)
              return (
                <HostedControlReason key={tool} label={label} reason={reason}>
                  <button className="panel-tool-shortcut w-full disabled:text-ink-4! disabled:pointer-events-none" disabled>
                    <Icon size={18} />
                    <span>{label}</span>
                  </button>
                </HostedControlReason>
              );
            return (
              <button key={tool} className="panel-tool-shortcut" onClick={() => onTool(tool)}>
                <Icon size={18} />
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
              <button key={url} className="panel-recent-page" data-tip={url} onClick={() => onNavigate(url)}>
                <Globe size={18} />
                <span>{pageHost(url)}</span>
              </button>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
