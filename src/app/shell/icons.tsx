import type { ReactNode } from 'react';

/**
 * The shell's icons: 24x24 grid, 1.6 stroke, round caps and joins (brand guide). Decorative (aria-hidden): every use sits beside a visible
 * label or inside a control that carries an aria-label. Drawn here as plain strokes of currentColor; nothing external is loaded.
 */
function Icon({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 24 24"
      width="24"
      height="24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      {children}
    </svg>
  );
}

const PATHS: Record<string, ReactNode> = {
  dashboard: (
    <>
      <path d="M4 11.5 12 4l8 7.5" />
      <path d="M6 10v9.5h12V10" />
    </>
  ),
  sales: (
    <>
      <path d="M4 5h2l2 10h9.5l2-7H7" />
      <circle cx="9.5" cy="19" r="1" />
      <circle cx="16.5" cy="19" r="1" />
    </>
  ),
  purchases: (
    <>
      <path d="M12 3 4 7v10l8 4 8-4V7z" />
      <path d="M4 7l8 4 8-4M12 11v10" />
    </>
  ),
  finance: (
    <>
      <rect x="3.5" y="6" width="17" height="12" rx="1.5" />
      <circle cx="12" cy="12" r="2.5" />
    </>
  ),
  production: (
    <>
      <path d="M3 18V9l6 3V9l6 3V6h3v12z" />
    </>
  ),
  masterData: (
    <>
      <ellipse cx="12" cy="6" rx="7" ry="2.5" />
      <path d="M5 6v6c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5V6M5 12v6c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5v-6" />
    </>
  ),
  administration: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1" />
    </>
  ),
  bell: (
    <>
      <path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z" />
      <path d="M10 20.5a2 2 0 0 0 4 0" />
    </>
  ),
  generic: <circle cx="12" cy="12" r="7" />,
};

export function NavIcon({ id, className }: { id: string; className?: string }) {
  return <Icon className={className}>{PATHS[id] ?? PATHS.generic}</Icon>;
}
