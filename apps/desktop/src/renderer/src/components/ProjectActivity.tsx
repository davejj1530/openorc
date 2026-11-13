import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import { HarnessLogo } from "./HarnessLogo";
import { ensureRpc, useRpc } from "../lib/client";
import { ACTIVITY_WEEKS, activityLevels, activityParams, activitySummary, dayDetail, dayLabel, formatCount } from "../lib/project-activity";

/** Each week's column is at least this wide; a narrower pane drops the oldest weeks rather than squeezing the dots. */
const WEEK_PX = 12;

/** Reads the activity the screen shows, so a project switch can wait for it like the rest of the screen. */
export function loadProjectActivity(projectId: string): Promise<unknown> {
  return ensureRpc("projects.activity", activityParams(projectId));
}

function useWeeksThatFit() {
  const ref = useRef<HTMLDivElement>(null);
  const [weeks, setWeeks] = useState(ACTIVITY_WEEKS);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const measure = () => setWeeks(Math.max(1, Math.min(ACTIVITY_WEEKS, Math.floor(element.clientWidth / WEEK_PX))));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return { ref, weeks };
}

/**
 * A year of the project's turns under the new thread composer, one dot a day that grows and darkens with the day's
 * work. The line above it gives the year's count, or the day under the pointer with each agent's share.
 */
export function ProjectActivity({ projectId }: { projectId: string }) {
  const midnight = new Date().setHours(0, 0, 0, 0);
  const params = useMemo(() => activityParams(projectId, midnight), [projectId, midnight]);
  const query = useRpc("projects.activity", params);
  // Dots sweep in only when the read lands after the screen shows; a switch that waited for it swaps them in place.
  const arrive = useRef(query.data === undefined).current;
  const { ref, weeks } = useWeeksThatFit();
  const [hovered, setHovered] = useState<number | null>(null);
  const [shown, setShown] = useState<number | null>(null);
  const days = query.data?.days;
  const levels = useMemo(() => activityLevels(days?.map((day) => day.turns) ?? []), [days]);
  const visible = days ? days.slice(Math.max(0, (ACTIVITY_WEEKS - weeks) * 7)) : [];
  const offset = (days?.length ?? 0) - visible.length;
  const turns = visible.reduce((sum, day) => sum + day.turns, 0);
  const steps = visible.reduce((sum, day) => sum + day.steps, 0);
  const firstActive = visible.findIndex((day) => day.turns > 0 || day.steps > 0);
  const since = firstActive >= 7 ? params.boundaries[offset + firstActive]! : null;
  const summary = activitySummary({ turns, steps, since, weeks, now: Date.now() });
  const detail = shown === null ? undefined : days?.[shown];

  const point = (event: PointerEvent<HTMLDivElement>) => {
    const index = (event.target as HTMLElement).dataset["day"];
    if (index === undefined) return;
    setHovered(Number(index));
    setShown(Number(index));
  };

  return (
    <div ref={ref} className="new-thread-activity">
      {days && days.some((day) => day.turns > 0) ? (
        <>
          <div className="new-thread-activity-readout motion-swap">
            <p aria-hidden={hovered !== null}>{summary}</p>
            <p aria-hidden={hovered === null} className="new-thread-activity-detail">
              {detail && shown !== null ? (
                <>
                  <span className="new-thread-activity-date">{dayLabel(params.boundaries[shown]!, Date.now())}</span>
                  <span>{dayDetail(detail)}</span>
                  <span className="new-thread-activity-agents">
                    {detail.agents.map((share) => (
                      <span key={share.agent}>
                        <HarnessLogo id={share.agent} size={12} />
                        <span className="tabular">{formatCount(share.turns)}</span>
                      </span>
                    ))}
                  </span>
                </>
              ) : null}
            </p>
          </div>
          <div
            className="new-thread-activity-days"
            role="img"
            aria-label={summary}
            data-arrive={arrive || undefined}
            style={{ "--weeks": weeks } as CSSProperties}
            onPointerOver={point}
            onPointerLeave={() => setHovered(null)}
          >
            {visible.map((_, index) => (
              <span
                key={params.boundaries[offset + index]}
                className="new-thread-activity-day"
                data-day={offset + index}
                data-level={levels[offset + index]}
                data-hovered={hovered === offset + index || undefined}
                style={{ "--week": Math.floor(index / 7) } as CSSProperties}
              />
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}
