import { formatUsageTime, graceDeadlineWords } from "@openorc/client";

export function AccountGraceLine({ until, now }: { until: number; now: number }) {
  const words = graceDeadlineWords(until, now);
  return (
    <span className="sidebar-account-grace" data-tip={formatUsageTime(until)}>
      <span className="sidebar-grace-long">{words.long}</span>
      <span className="sidebar-grace-short">{words.short}</span>
    </span>
  );
}
