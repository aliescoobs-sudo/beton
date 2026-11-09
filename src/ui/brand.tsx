import { resolveBrand, type BrandTone, type BrandVariant } from './brand-logo';

// No inline style anywhere: the CSP (style-src 'self' + nonce) blocks style attributes. Sizes are HTML attributes and the clear space is
// a class from this closed table (literal class names, so Tailwind generates them). The test in brand-logo.test.ts checks every entry
// against the rule "clear space = 1/4 of the symbol height".
export const BRAND_WIDTHS = [48, 160, 200, 240, 320] as const;
export type BrandWidth = (typeof BRAND_WIDTHS)[number];
export const PAD_CLASS: Record<number, string> = {
  38: 'p-[10px]',
  35: 'p-[9px]',
  44: 'p-[11px]',
  52: 'p-[13px]',
  70: 'p-[18px]',
};

/**
 * The KAYAS logo: the traced SVG as a static file in a plain <img> (alt "KAYAS"), never edited, recoloured or stretched (width attribute,
 * height auto). `width` is the logo's own width in px; the clear space (1/4 of the symbol height) is added around it as padding. Below
 * 160 px wide the symbol alone is shown (the name is then carried by the context). Tones: `colour` on light backgrounds, `white` on Forêt
 * or dark bands, `forest`/`black` for one-ink cases only.
 */
export function Brand({
  variant = 'signature',
  tone = 'colour',
  width = 160,
  className = 'inline-block',
}: {
  variant?: BrandVariant;
  tone?: BrandTone;
  width?: BrandWidth;
  className?: string;
}) {
  const spec = resolveBrand({ variant, tone, width });
  return (
    <span
      className={`shrink-0 leading-none ${PAD_CLASS[spec.height] ?? ''} ${className}`.trim()}
      data-brand={spec.variant}
    >
      {/* A static SVG: next/image would add nothing (no optimisation of a vector) and the logo must not be re-encoded. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={spec.src} alt="KAYAS" width={spec.width} height={spec.height} className="h-auto max-w-none" />
    </span>
  );
}
