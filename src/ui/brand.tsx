import { resolveBrand, type BrandTone, type BrandVariant } from './brand-logo';

/**
 * The KAYAS logo: the traced SVG as a static file in a plain <img> (alt "KAYAS"), never edited, recoloured or stretched. `width` is the
 * logo's own width in px; the clear space (1/4 of the symbol height) is added around it as padding. Below 160 px wide the symbol alone is
 * shown (the name is then carried by the context). Tones: `colour` on light backgrounds, `white` on Forêt or dark bands, `forest`/`black`
 * for one-ink cases only.
 */
export function Brand({
  variant = 'signature',
  tone = 'colour',
  width = 160,
  className,
}: {
  variant?: BrandVariant;
  tone?: BrandTone;
  width?: number;
  className?: string;
}) {
  const spec = resolveBrand({ variant, tone, width });
  return (
    <span
      className={className}
      style={{ display: 'inline-block', padding: spec.clearSpace, lineHeight: 0 }}
      data-brand={spec.variant}
    >
      {/* A static SVG: next/image would add nothing (no optimisation of a vector) and the logo must not be re-encoded. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={spec.src}
        alt="KAYAS"
        width={spec.width}
        height={spec.height}
        style={{ width: spec.width, height: 'auto' }}
      />
    </span>
  );
}
