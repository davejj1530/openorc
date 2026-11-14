import type { ReactNode } from "react";
import { Tooltip } from "./ui";

/** A disabled control keeps a focus target, so its reason is available without a pointer. */
export function HostedControlReason({ reason, label, children }: { reason: string | null; label: string; children: ReactNode }) {
  if (!reason) return children;
  return (
    <Tooltip label={reason} positionerClassName="z-50" render={<span tabIndex={0} aria-label={label} aria-disabled="true" className="inline-flex" />}>
      {children}
    </Tooltip>
  );
}
