/** Rest pose of the Rive artwork; CSS colors also work before WASM loads and with reduced motion. */
export function MascotStill({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 500 500" fill="none" aria-hidden="true">
      <g transform="translate(250 235)">
        <path
          fill="var(--mascot-body)"
          d="M0-110C70-110 105-101 110-50C114-25 114 29 108 60C102 101 78 111 25 112C-5 113-40 113-64 106C-103 98-112 74-113 29C-114 2-113-31-106-57C-95-102-64-110 0-110Z"
        />
        <g transform="translate(-18 -10)" fill="var(--mascot-eyes)">
          <rect x="-38" y="-28" width="22" height="56" rx="11" />
          <rect x="16" y="-28" width="22" height="56" rx="11" />
        </g>
      </g>
    </svg>
  );
}
