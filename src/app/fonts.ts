import localFont from 'next/font/local';

// Alexandria (titles, section titles, large numbers) and Readex Pro (everything else), both SIL OFL, self-hosted from
// src/fonts through next/font: served from /_next/static/media, so no external request and the CSP (`font-src 'self'`)
// is unchanged. One instance per script and family: the Latin file has no Arabic glyphs, so Arabic text falls through
// the font stack to the Arabic file (and the other way round).
export const alexandriaLatin = localFont({
  src: [{ path: '../fonts/Alexandria-latin-variable.woff2', weight: '100 900', style: 'normal' }],
  variable: '--font-alexandria-latin',
  display: 'swap',
  // No synthetic Arial fallback: it would answer for the glyphs the other script's file lacks before the stack reaches it.
  adjustFontFallback: false,
});
export const alexandriaArabic = localFont({
  src: [{ path: '../fonts/Alexandria-arabic-variable.woff2', weight: '100 900', style: 'normal' }],
  variable: '--font-alexandria-arabic',
  display: 'swap',
  // No synthetic Arial fallback: it would answer for the glyphs the other script's file lacks before the stack reaches it.
  adjustFontFallback: false,
});
export const readexLatin = localFont({
  src: [{ path: '../fonts/ReadexPro-latin-variable.woff2', weight: '160 700', style: 'normal' }],
  variable: '--font-readex-latin',
  display: 'swap',
  // No synthetic Arial fallback: it would answer for the glyphs the other script's file lacks before the stack reaches it.
  adjustFontFallback: false,
});
export const readexArabic = localFont({
  src: [{ path: '../fonts/ReadexPro-arabic-variable.woff2', weight: '160 700', style: 'normal' }],
  variable: '--font-readex-arabic',
  display: 'swap',
  // No synthetic Arial fallback: it would answer for the glyphs the other script's file lacks before the stack reaches it.
  adjustFontFallback: false,
});

/** The four `variable` classes, set once on <html>. */
export const fontClasses = [
  alexandriaLatin.variable,
  alexandriaArabic.variable,
  readexLatin.variable,
  readexArabic.variable,
].join(' ');
