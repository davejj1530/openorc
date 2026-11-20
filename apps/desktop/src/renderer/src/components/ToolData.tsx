import { useState, type ReactNode } from "react";
import { fieldLabel } from "@openorc/client";
import { ThreadLink } from "./ThreadImages";

/** How far in the outline goes before a value is shown as written, and how many of a list show before the rest wait. */
const DEPTH = 3;
const ITEMS = 5;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isEmpty = (value: unknown) => value === null || value === undefined || value === "" || (Array.isArray(value) && !value.length);

/** Words past this many lines or letters start folded to their first lines. */
const LONG = { lines: 6, letters: 480 };

/** One value in words: yes or no, a link for an address, long words folded to their start, anything else as it is. */
function Plain({ value }: { value: unknown }): ReactNode {
  const [all, setAll] = useState(false);
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value !== "string") return String(value);
  if (/^https?:\/\/\S+$/.test(value)) return <ThreadLink href={value}>{value}</ThreadLink>;
  if (all || (value.length <= LONG.letters && value.split("\n").length <= LONG.lines)) return value;
  return (
    <>
      <span className="tool-data-long">{value}</span>
      <button type="button" className="tool-view-more" onClick={() => setAll(true)}>
        Show all
      </button>
    </>
  );
}

/**
 * What a call gave back as data, read as an outline: each name in words, each value as itself, a list as its items.
 * Past a few levels a value is shown as written. The data exactly as it came is the raw call's to show.
 */
export function ToolData({ value, depth = 0 }: { value: unknown; depth?: number }) {
  if (depth >= DEPTH && typeof value === "object") return <pre className="tool-data-raw">{JSON.stringify(value, null, 2)}</pre>;
  if (Array.isArray(value)) return <DataList items={value} depth={depth} />;
  if (!isRecord(value))
    return (
      <span className="tool-data-value">
        <Plain value={value} />
      </span>
    );
  const entries = Object.entries(value).filter(([, each]) => !isEmpty(each));
  return (
    <dl className="tool-view-fields tool-data">
      {entries.map(([key, each]) => (
        <div key={key}>
          <dt>{fieldLabel(key)}</dt>
          <dd>
            <ToolData value={each} depth={depth + 1} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** A list: plain values in a line, things as items under one another, the first few until the rest are asked for. */
function DataList({ items, depth }: { items: unknown[]; depth: number }) {
  const [all, setAll] = useState(false);
  if (items.every((item) => typeof item !== "object" || item === null)) return <span className="tool-data-value">{items.map(String).join(", ")}</span>;
  const shown = all ? items : items.slice(0, ITEMS);
  return (
    <div className="tool-data-items">
      <ol>
        {shown.map((item, index) => (
          <li key={index}>
            <ToolData value={item} depth={depth + 1} />
          </li>
        ))}
      </ol>
      {items.length > shown.length ? (
        <button type="button" className="tool-view-more" onClick={() => setAll(true)}>
          Show all {items.length}
        </button>
      ) : null}
    </div>
  );
}
