// KAYAS logo rules (docs/BRAND-KAYAS.md), as pure functions so a test can pin them. The files are the SVGs of the FLUX trace package in
// public/brand/svg: nothing here edits, recolours or redraws them. The height is always derived from the width with the file's own ratio.
// The SVGs are a TRACE of a raster, not an original vector master (docs/brand/KAYAS-FLUX-TRACE-README.md).

export type BrandTone = 'colour' | 'forest' | 'black' | 'white';
export type BrandVariant = 'signature' | 'symbol';

export const SIGNATURE_RATIO = { width: 1278, height: 279 } as const;
export const SYMBOL_RATIO = { width: 353, height: 279 } as const;
/** The signature is never shown narrower than this (px). */
export const SIGNATURE_MIN_WIDTH = 120;
/** Below this width (px) the symbol alone is used and the name is carried by the context (a heading, an aria-label). */
export const SIGNATURE_PREFERRED_MIN_WIDTH = 160;

export interface BrandSpec {
  variant: BrandVariant;
  src: string;
  width: number;
  height: number;
  /** Clear space on all four sides: x = 1/4 of the visible symbol height (px). */
  clearSpace: number;
}

/** `width` is the width of the logo itself, not counting the clear space. */
export function resolveBrand(opts: { variant?: BrandVariant; tone?: BrandTone; width: number }): BrandSpec {
  const tone = opts.tone ?? 'colour';
  const signature =
    (opts.variant ?? 'signature') === 'signature' && opts.width >= SIGNATURE_PREFERRED_MIN_WIDTH;
  const ratio = signature ? SIGNATURE_RATIO : SYMBOL_RATIO;
  const width = Math.round(opts.width);
  const height = Math.round((width * ratio.height) / ratio.width);
  const variant: BrandVariant = signature ? 'signature' : 'symbol';
  // The symbol is as tall as the signature (both files are 279 units high), so x is a quarter of the rendered height.
  return {
    variant,
    src: `/brand/svg/kayas-${variant}-${tone}.svg`,
    width,
    height,
    clearSpace: Math.round(height / 4),
  };
}

/** The right tone for a background: colour on light, white on the Forêt/dark bands. Forêt and black are one-ink cases, asked for explicitly. */
export function toneForBackground(background: 'light' | 'forest' | 'dark'): BrandTone {
  return background === 'light' ? 'colour' : 'white';
}
