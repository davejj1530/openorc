/** A flat face from the Orcling family; the surrounding UI supplies its color. */
export function OpenOrcMark({ size = 30, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true" className={className}>
      <path
        fill="currentColor"
        fillRule="evenodd"
        d="M16 2C27 2 30 5 30 16S27 30 16 30 2 27 2 16 5 2 16 2ZM11 11a1.8 1.8 0 0 0-1.8 1.8v6.4a1.8 1.8 0 1 0 3.6 0v-6.4A1.8 1.8 0 0 0 11 11Zm10 0a1.8 1.8 0 0 0-1.8 1.8v6.4a1.8 1.8 0 1 0 3.6 0v-6.4A1.8 1.8 0 0 0 21 11Z"
        clipRule="evenodd"
      />
    </svg>
  );
}
