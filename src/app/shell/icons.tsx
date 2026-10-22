import type { NavIcon } from './nav-model';

const PATHS: Record<NavIcon, string> = {
  home: 'M3 11.5 12 4l9 7.5M5.5 10v9.5h13V10M10 19.5v-5h4v5',
  sales: 'M4 6h16M4 12h16M4 18h10',
  purchases: 'M5 8h14l-1.2 11H6.2L5 8Zm4-.5V6a3 3 0 0 1 6 0v1.5',
  production: 'M3 19V9l6 3V9l6 3V6h6v13H3Z',
  data: 'M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3Zm0 0v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
  admin: 'M12 3 4.5 6v5.5c0 4.4 3.1 8.1 7.5 9.5 4.4-1.4 7.5-5.1 7.5-9.5V6L12 3Z',
};

export function NavGlyph({ name }: { name: NavIcon }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
