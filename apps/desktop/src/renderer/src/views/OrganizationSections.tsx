import { useId, useRef, type ReactNode } from "react";
import type { OrganizationSection } from "../lib/organization-section";
import "./organization-seats.css";

export function OrganizationSections({ section, select, children }: { section: OrganizationSection; select(section: OrganizationSection): void; children?: ReactNode }) {
  const id = useId();
  const buttons = useRef<Partial<Record<OrganizationSection, HTMLButtonElement | null>>>({});
  return (
    <>
      <div className="seats-tabs" role="tablist" aria-label="Organization">
        {(["people", "seats"] as const).map((name) => (
          <button
            key={name}
            type="button"
            role="tab"
            id={`${id}-${name}`}
            aria-controls={`${id}-panel`}
            aria-selected={section === name}
            tabIndex={section === name ? 0 : -1}
            ref={(button) => {
              buttons.current[name] = button;
            }}
            onClick={() => select(name)}
            onKeyDown={(event) => {
              const next = tabKey(event.key, name);
              if (!next) return;
              event.preventDefault();
              select(next);
              buttons.current[next]?.focus();
            }}
          >
            {name === "people" ? "People" : "Seats"}
          </button>
        ))}
      </div>
      <section role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-${section}`}>
        {children}
      </section>
    </>
  );
}

function tabKey(key: string, current: OrganizationSection): OrganizationSection | null {
  if (key === "Home") return "people";
  if (key === "End") return "seats";
  if (key === "ArrowLeft" || key === "ArrowRight") return current === "people" ? "seats" : "people";
  return null;
}
