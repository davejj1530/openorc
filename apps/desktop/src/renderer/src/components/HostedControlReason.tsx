import type { ReactNode } from "react";

/** A disabled control keeps a focus target, so its reason is available without a pointer. */
export function HostedControlReason({ reason, label, children }: { reason: string | null; label: string; children: ReactNode }) {
  if (!reason) return children;
  return (
    <span tabIndex={0} aria-label={label} aria-disabled="true" data-tip={reason} className="inline-flex">
      {children}
    </span>
  );
}
