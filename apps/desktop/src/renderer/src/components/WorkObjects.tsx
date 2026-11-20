import type { EditObject, WebObject } from "@openorc/client";
import { ThreadLink } from "./ThreadImages";
import "./WorkObjects.css";

/** A few of the lines an edit took out and put in. */
export function EditLines({ edit }: { edit: EditObject }) {
  if (!edit.lines.length) return null;
  return (
    <div className="work-edit-lines">
      {edit.lines.map((line, index) => (
        <span key={index} className="work-edit-line" data-sign={line.sign}>
          <span className="work-edit-sign" aria-label={line.sign === "+" ? "Added" : "Removed"}>
            {line.sign === "+" ? "+" : "−"}
          </span>
          {line.text}
        </span>
      ))}
    </div>
  );
}

/** Web results a search shows before the rest. */
const HITS = 5;

const host = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

/** The first pages a web search found: where each is from, then its title. */
export function WebResults({ web }: { web: WebObject }) {
  if (!web.links.length) return null;
  return (
    <div className="work-results">
      {web.links.slice(0, HITS).map((link) => (
        <ThreadLink key={link.url} href={link.url}>
          <span className="work-result-host">{host(link.url)}</span>
          <span className="work-result-title">{link.title}</span>
        </ThreadLink>
      ))}
    </div>
  );
}
