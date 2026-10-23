/** A silo outline in signal red: the brand mark. Decorative (the name sits next to it). */
export function SiloMark({ size = 26 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="var(--color-signal)"
      strokeWidth="2"
      strokeLinejoin="round"
      strokeLinecap="square"
      aria-hidden="true"
    >
      <path d="M6 7a6 3 0 0 1 12 0v11H6V7Z" />
      <path d="M6 7a6 3 0 0 0 12 0M9 18v3M15 18v3M6 12.5a6 3 0 0 0 12 0" />
    </svg>
  );
}
