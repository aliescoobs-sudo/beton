import localFont from 'next/font/local';

// IBM Plex Sans (Latin, variable weight) and IBM Plex Sans Arabic, self-hosted from src/fonts (SIL OFL, see LICENSE.txt)
// through next/font: served from /_next/static/media, so no external request and the CSP (`font-src 'self'`) is unchanged.
export const plexSans = localFont({
  src: [{ path: '../fonts/IBMPlexSans-latin-variable.woff2', weight: '400 600', style: 'normal' }],
  variable: '--font-plex-sans',
  display: 'swap',
});

export const plexArabic = localFont({
  src: [
    { path: '../fonts/IBMPlexSansArabic-arabic-400.woff2', weight: '400', style: 'normal' },
    { path: '../fonts/IBMPlexSansArabic-arabic-500.woff2', weight: '500', style: 'normal' },
    { path: '../fonts/IBMPlexSansArabic-arabic-600.woff2', weight: '600', style: 'normal' },
  ],
  variable: '--font-plex-arabic',
  display: 'swap',
});
