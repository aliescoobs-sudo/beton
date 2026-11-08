# KAYAS FLUX - TRACE asset package

Prepared 2026-11-08. This package implements the adopted FLUX drawing; it does not propose a redesign.

**These vectors are a TRACE of a raster. They are not an original vector master.**
All logo lettering is outlined from the existing image. No font was substituted for KAYAS.

## 1. Source and factual provenance

- **Name KAYAS:** in the retrievable earlier project history, Ali supplied/corrected the company name to KAYAS (2026-11-07). I did not invent the name in this delivery. The available record does not establish who originally coined it or its legal ownership.
- **Symbol and wordmark:** FLUX was generated in an earlier ChatGPT image-generation logo-exploration step, introduced as direction 02 - FLUX, then refined through generated studies. The retained card is titled `01 / FLUX - AJUSTEMENT`. The earlier conversation explicitly called those images generated studies. It was not a pre-existing editable vector design.
- **Supplied image or outside brand:** I have not identified an owner-uploaded finished logo, stock asset, or named external brand as the direct source of this FLUX drawing in the retrievable history. I cannot reconstruct every earlier influence or the image model's training sources. This is not a claim of exclusive originality.
- **Possible existing-brand resemblance:** I do not have a verified match to a named existing brand. I cannot guarantee that the name, ribbon-like K symbol, or lettering does not resemble or match an existing mark. No name, trademark or logo-similarity search was performed for this delivery, as requested.

The surviving original generated card is 1536 x 1024 px. Its main logo area has essentially the same effective resolution as the guideline image: 1278 x 279 px. **No higher-resolution version of this exact drawing and no original vector source were found.** Older FLUX drawings are not substituted for the adopted one.

To avoid an extra resampling step, the native logo image used by Brand Guidelines 01 v0.2 was extracted at its stored resolution. `source/kayas-signature-source.png` preserves that legacy appearance for the comparison; it is NOT one of the clean assets. The source card itself is not repackaged as a poster.

Source lineage:

- Generated reference card: `exec-0d447c9f-742a-478a-9630-c54fc854a654.png`.
- Card SHA-256: `f10a8614e1cada01c9dda0d1b9e390b2c9441e4602928fd7f0a52216eb74865c`.
- Guideline: KAYAS Brand Guidelines 01, study FLUX, v0.2, native page-4 image 1278 x 279; symbol 353 x 279; wordmark 891 x 209.
- Guideline Library ID: `libfile_fcf1d42d51e081918264c9cbc30b80af`, version 1 at retrieval.

## 2. What the trace preserves, and what differs at 400%

Preserved: the adopted symbol's two separated main components, the diagonal opening and lower internal cutout; the five existing letters and both A counters; the horizontal spacing and the relative placements of symbol and name. No new white channel was invented at the green/Citron colour join. One-ink versions use the same overall silhouette. The separately generated small mono example on the old reference card was not used to replace that silhouette.

Method: estimate the visible 50% coverage boundary from the native raster, fit optimized cubic Bezier contours, retain the counters/openings, and construct the two colour regions from shared outer geometry. This is a computational contour trace with visual review, not hand-drawn original artwork. SVGs use flat path fills only: no embedded bitmap, live type, gradients, filters, shadows, strokes or external dependencies. PDFs use the same paths and have no raster images or font resources.

The monochrome signature has 132 line/cubic segments: 33 in the symbol and 99 in the wordmark. The colour signature has 141 segments because the green/Citron partition adds its boundary. This is an optimized fit, not a mathematical claim that no smaller node set is possible.

At 400%:

- The raster's stepped/antialiased edges become smooth Bezier edges. Very small corner and curve shifts remain; they are not claimed to be pixel-exact.
- Flat Forêt and Citron replace the slight tonal texture/shading in the generated raster, as expressly requested.
- Native-grid silhouette comparison, at a 50% alpha threshold: intersection-over-union **99.443%**; **900 native pixels** differ. Symmetric raster-boundary distance: mean **0.158 px**, 95th percentile **1.0 px**, maximum **1.0 px**. One native pixel displays as four pixels in the 400% proof.
- Citron-region comparison: intersection-over-union **99.286%**; maximum sampled raster-boundary distance **1.0 native px**. The colour boundary cannot be recovered with subpixel certainty from this source.

These measurements compare rasterized boundaries on the native pixel grid; they are not a proof that the underlying continuous curves are identical. Threshold selection and the original antialiasing introduce uncertainty. `qa/kayas-trace-overlay-400.png` puts the source and flat trace side by side, followed by the silhouette difference overlay. Grey = shared area; magenta = source-only; cyan = trace-only. The overlay deliberately compares silhouettes, not the removed tonal texture.

## 3. Vector variants and geometry

All four SVG colourways are supplied for symbol, horizontal signature, wordmark and vertical lockup. Four colour vector PDFs are supplied, one per lockup. The wordmark's `colour` and `forest` files are intentionally equivalent because the original wordmark is entirely Forêt.

| Variant | SVG viewBox / source-coordinate canvas | Geometry |
|---|---|---|
| symbol | 353 x 279 | Same native symbol crop |
| signature | 1278 x 279 | Original horizontal placement |
| wordmark | 891 x 209 | Existing outlined letters, translated -387 / -36 from signature coordinates |
| vertical | 891 x 762.405689 | Page-5 arrangement reproduced from the actual PDF image rectangles |

For the vertical composition, symbol scale is 1.566669923, symbol x is 172.055172, and the wordmark starts at y=553.405689, in the normalized 891-unit-wide canvas. This preserves the page-5 size relation and gap, including its small one-point horizontal offset; no optical recentering was introduced. The SVG's numeric viewBox can have a fractional height. PNG height is rounded up to a whole pixel without stretching the drawing.

PDF pages are bare artwork, not a physical-size vehicle, sign or embroidery layout. A white-only SVG/PNG is intentionally invisible on a white viewer background; check it on Forêt.

## 4. Exact colours

| Name | HEX | RGB | Role in this package |
|---|---|---|---|
| Forêt | #01592B | 1 / 89 / 43 | Main logo, one-ink version and app background |
| Citron | #9ADA02 | 154 / 218 / 2 | Original symbol accent |
| Graphite | #292929 | 41 / 41 / 41 | Specimen / QA text; not substituted for Forêt in the logo |
| Craie | #F5F5F5 | 245 / 245 / 245 | Neutral QA background |
| Black | #000000 | 0 / 0 / 0 | Requested black one-ink exports |
| White | #FFFFFF | 255 / 255 / 255 | Requested white one-ink exports / white icon background |

SVG/PDF fills and clean PNG foreground values use these sRGB values. No CMYK, spot-ink, thread or physical proof is asserted by these screen-space colour values.

## 5. Transparent PNGs and edge checks

| Variant | Largest PNG width | Additional widths |
|---|---:|---|
| signature | 4096 px | 1024 / 512 px |
| wordmark | 4096 px | 1024 / 512 px |
| symbol | 2048 px | 1024 / 512 px |
| vertical | 2048 px | 1024 / 512 px |

Each exists in `colour`, `forest`, `black`, `white`; directory names disambiguate sizes while filenames stay `kayas-<variant>-<colourway>.png`. All 48 are true transparent RGBA exports from the vector geometry. The four colourways have identical alpha coverage at every matching size/variant.

Edge result: **no retained white/black matte fringe or halo was found in the clean exports.** All 481,880 partly transparent edge pixels across the 48 PNGs were checked. Monochrome edge RGB is exactly its requested fill; colour edge RGB is only a coverage-weighted mix of Forêt and Citron (maximum 8-bit rounding residual 0.740 RGB units from that colour segment). Fully transparent pixels have RGB zero. Coverage antialiasing is intentional, not a matte. Very low-alpha edge pixels are given unassociated foreground RGB rather than quantized premultiplied colour, preventing the old light fringe.

`qa/kayas-edge-checks.png` shows all colourways of symbol and signature on white, Forêt and Citron. Use white on Forêt, and Forêt/black on white or Citron. Green artwork on identical green, or white on white, disappearing is expected contrast behaviour, not an edge defect. White on Citron is low contrast. Do not treat `source/kayas-signature-source.png` as a clean export.

## 6. App icons, favicon and 24 px check

- Three 1024 x 1024 masters: colour symbol on white, white symbol on Forêt, and one-ink Forêt on transparent. Symbol canvas is fitted to 60% of icon width: about 20% reserve per side, centred vertically. No corner radius is baked in.
- PWA `any`: 192 and 512, white symbol on solid Forêt.
- PWA `maskable`: 192 and 512, white symbol on solid Forêt. Entire foreground is inside the centred safe circle of radius 40% of the icon width (the 80%-diameter safe zone). Measured maximum art radius is 36.864% of width, including antialiased pixels. The full background is solid, not transparent.
- `any` and `maskable` images intentionally share the same geometry/padding; use the corresponding purpose in your app manifest. No manifest or app code is added to this package.
- Apple touch icon: 180 x 180, white symbol on solid Forêt.
- `icons/favicon.ico`: separate 16, 32 and 48 px frames. Favicon PNGs: 32 and 48. Colour on opaque white, with reserve tightened to 12.5% per side for small-icon reading.

At 24 px, the silhouette and main diagonal opening remain identifiable in the provided native-size test. Fine detail is necessarily small. **No drawing, gap, colour, angle, stroke or letter was changed for small sizes; only the favicon padding differs.** `qa/kayas-icon-legibility-24.png` shows actual 24 px samples and pixel enlargements. The 16 px ICO has limited fine detail; no pixel-grid redesign was made. This is a bitmap inspection, not testing on every operating system, browser or physical phone.

## 7. Open-licence communication fonts

The logo is always the existing outline; neither proposed font is used to reconstruct KAYAS.

| Use | Proposed family | Weights to use | Licence | Official source |
|---|---|---|---|---|
| Latin UI | Inter | Regular 400 / Bold 700 | SIL OFL 1.1 | https://github.com/rsms/inter ; https://github.com/google/fonts/tree/main/ofl/inter |
| Arabic, Naskh style | Noto Naskh Arabic | Regular 400 / Bold 700 | SIL OFL 1.1 | https://github.com/notofonts/arabic ; https://github.com/google/fonts/tree/main/ofl/notonaskharabic |

Official licence files:

- Inter: https://github.com/google/fonts/blob/main/ofl/inter/OFL.txt
- Noto Naskh Arabic: https://github.com/google/fonts/blob/main/ofl/notonaskharabic/OFL.txt

Both licences explicitly permit embedding and redistribution with software under their conditions; the unchanged licence texts with copyright notices are included alongside the fonts. No Apple font file is included or required. These are visual substitutes for the communication system, not metric-identical replacements for Helvetica Neue and Geeza Pro. Inter supplies a neutral screen sans; Noto supplies a connected Naskh text design with a different size/line-height profile from Geeza.

The two supplied variable TTFs are unmodified upstream files with package filenames only changed. Inter supports weight 100-900 and optical size 14-32; Noto supports weight 400-700. Use 400 and 700 for this system. The specimen uses actual 400/700 instances, with Inter optical size 14. No synthetic bold, system fallback or Apple font is used in it. The temporary instances used for rendering are not shipped as additional font products.

Glyph checks and rendering:

- **Inter:** Latin digits, accents in the French sample, `m3 / DH`, and `m³ / DH` are present and render clearly. It does not contain Arabic: explicitly assign Noto to Arabic text.
- **Noto Naskh Arabic:** Arabic sample characters, Latin digits and `m3 / DH` are present and render. Its Latin digits/letters have serif forms; for a consistent app, explicitly style numeric/unit spans with Inter.
- **U+00B3 (superscript 3) is absent in this Noto file.** Render volume units `m³` in Inter; do not rely on an unspecified operating-system font fallback.
- Keep Latin numbers/unit runs LTR (for example with an explicit `dir="ltr"` span) inside an RTL interface. This avoids reordering `0123456789  m3 / DH`.

`qa/kayas-font-specimen.png` actually renders the page-13/14 French and Arabic samples, including `Votre chantier, notre point de départ.`, `طلب عرض ثمن`, the Arabic body sample, and `0123456789  m3 / DH` in the proposed families. The Latin line inside the Noto column uses Noto itself, so its different numeral/Latin shape is visible.

Font downloads and SHA-256:

| Package font | Upstream binary URL | SHA-256 |
|---|---|---|
| kayas-font-latin-variable.ttf | https://raw.githubusercontent.com/google/fonts/main/ofl/inter/Inter%5Bopsz,wght%5D.ttf | `29160a80ff49ddcab2c97711247e08b1fab27a484a329ce8b813d820dc559031` |
| kayas-font-arabic-variable.ttf | https://raw.githubusercontent.com/google/fonts/main/ofl/notonaskharabic/NotoNaskhArabic%5Bwght%5D.ttf | `67b5a525a661b607971fbd3f96a81b89d3a768e74534fca84f18ac97e6fab72f` |

Downloads checked 2026-11-08. The URLs can evolve; the hashes identify the exact bundled bytes. Keep the two licence text files with the fonts when distributing the app.

## 8. What could not be established or done faithfully from this source

1. An original vector master, higher-resolution exact source, original control points and the logo's original typeface could not be recovered. These remain disclosed raster traces, not original design files.
2. Pixel-perfect subpixel contour recovery is impossible from this antialiased 279 px-high raster. The measured differences above and 400% proof show the approximation explicitly. No redesigned letter or symbol is presented as a faithful original.
3. The raster's tonal texture is intentionally absent in the flat assets, as requested.
4. Exclusive originality, legal ownership, and existing-brand/name clearance are not established by the available provenance. No trademark search is claimed.
5. Physical print, vehicle vinyl, embroidery, thread matching and every-device icon rendering were not tested. These paths are scalable artwork, not stitch files or measured application templates.
6. The free font pair is visually compatible, not metrically interchangeable with the Apple system fonts. Noto's missing superscript 3 requires Inter for that unit.

## 9. Complete file inventory

Byte sizes are exact uncompressed sizes. `vector TRACE` means editable paths reconstructed from the raster; `raster from TRACE` means a rendered derivative, not an original high-resolution photograph or design. README's own size is included. The outer ZIP is not listed as one of its own members.

| File | Bytes | Dimensions | Type / limitation |
|---|---:|---|---|
| `fonts/kayas-font-arabic-license.txt` | 4382 | - | license text. Verbatim upstream SIL Open Font License 1.1 including copyright notice. |
| `fonts/kayas-font-arabic-variable.ttf` | 307592 | - | font software (OFL-1.1). Unmodified upstream variable TTF; use 400 Regular and 700 Bold. |
| `fonts/kayas-font-latin-license.txt` | 4377 | - | license text. Verbatim upstream SIL Open Font License 1.1 including copyright notice. |
| `fonts/kayas-font-latin-variable.ttf` | 876576 | - | font software (OFL-1.1). Unmodified upstream variable TTF; use 400 Regular and 700 Bold. |
| `icons/1024/kayas-appicon-colour-on-white.png` | 30979 | 1024 x 1024 px | raster from TRACE. 1024 square; 20% reserve at left and right; vertically centred. |
| `icons/1024/kayas-appicon-forest.png` | 22503 | 1024 x 1024 px | raster from TRACE. 1024 square; 20% reserve at left and right; vertically centred. |
| `icons/1024/kayas-appicon-white-on-forest.png` | 29897 | 1024 x 1024 px | raster from TRACE. 1024 square; 20% reserve at left and right; vertically centred. |
| `icons/180/kayas-apple-touch-white-on-forest.png` | 3978 | 180 x 180 px | raster from TRACE. 180 square; solid background; 20% side reserve. |
| `icons/192/kayas-pwa-any-white-on-forest.png` | 4251 | 192 x 192 px | raster from TRACE. 192 square; solid Forêt; white symbol bbox inside centred 80%-diameter safe circle. |
| `icons/192/kayas-pwa-maskable-white-on-forest.png` | 4251 | 192 x 192 px | raster from TRACE. 192 square; solid Forêt; white symbol bbox inside centred 80%-diameter safe circle. |
| `icons/32/kayas-favicon-colour-on-white.png` | 982 | 32 x 32 px | raster from TRACE. 32 square; 12.5% side reserve for small favicon only; no drawing change. |
| `icons/48/kayas-favicon-colour-on-white.png` | 1431 | 48 x 48 px | raster from TRACE. 48 square; 12.5% side reserve for small favicon only; no drawing change. |
| `icons/512/kayas-pwa-any-white-on-forest.png` | 13148 | 512 x 512 px | raster from TRACE. 512 square; solid Forêt; white symbol bbox inside centred 80%-diameter safe circle. |
| `icons/512/kayas-pwa-maskable-white-on-forest.png` | 13148 | 512 x 512 px | raster from TRACE. 512 square; solid Forêt; white symbol bbox inside centred 80%-diameter safe circle. |
| `icons/favicon.ico` | 2944 | 16 / 32 / 48 px | raster from TRACE. ICO containing separate 16/32/48 frames; opaque white background; 12.5% reserve. |
| `pdf/kayas-signature-colour.pdf` | 4341 | - | vector TRACE. Vector PDF converted from the same SVG; no raster content. |
| `pdf/kayas-symbol-colour.pdf` | 1940 | - | vector TRACE. Vector PDF converted from the same SVG; no raster content. |
| `pdf/kayas-vertical-colour.pdf` | 4369 | - | vector TRACE. Vector PDF converted from the same SVG; no raster content. |
| `pdf/kayas-wordmark-colour.pdf` | 3347 | - | vector TRACE. Vector PDF converted from the same SVG; no raster content. |
| `png/1024/kayas-signature-black.png` | 19077 | 1024 x 224 px | raster from TRACE. Transparent RGBA, width 1024 px; unchanged traced proportions. |
| `png/1024/kayas-signature-colour.png` | 24062 | 1024 x 224 px | raster from TRACE. Transparent RGBA, width 1024 px; unchanged traced proportions. |
| `png/1024/kayas-signature-forest.png` | 23303 | 1024 x 224 px | raster from TRACE. Transparent RGBA, width 1024 px; unchanged traced proportions. |
| `png/1024/kayas-signature-white.png` | 22627 | 1024 x 224 px | raster from TRACE. Transparent RGBA, width 1024 px; unchanged traced proportions. |
| `png/1024/kayas-symbol-black.png` | 29523 | 1024 x 810 px | raster from TRACE. Transparent RGBA, width 1024 px; unchanged traced proportions. |
| `png/1024/kayas-symbol-colour.png` | 35463 | 1024 x 810 px | raster from TRACE. Transparent RGBA, width 1024 px; unchanged traced proportions. |
| `png/1024/kayas-symbol-forest.png` | 33522 | 1024 x 810 px | raster from TRACE. Transparent RGBA, width 1024 px; unchanged traced proportions. |
| `png/1024/kayas-symbol-white.png` | 32708 | 1024 x 810 px | raster from TRACE. Transparent RGBA, width 1024 px; unchanged traced proportions. |
| `png/1024/kayas-vertical-black.png` | 39761 | 1024 x 877 px | raster from TRACE. Transparent RGBA, width 1024 px; unchanged traced proportions. |
| `png/1024/kayas-vertical-colour.png` | 46440 | 1024 x 877 px | raster from TRACE. Transparent RGBA, width 1024 px; unchanged traced proportions. |
| `png/1024/kayas-vertical-forest.png` | 45137 | 1024 x 877 px | raster from TRACE. Transparent RGBA, width 1024 px; unchanged traced proportions. |
| `png/1024/kayas-vertical-white.png` | 44222 | 1024 x 877 px | raster from TRACE. Transparent RGBA, width 1024 px; unchanged traced proportions. |
| `png/1024/kayas-wordmark-black.png` | 19880 | 1024 x 241 px | raster from TRACE. Transparent RGBA, width 1024 px; unchanged traced proportions. |
| `png/1024/kayas-wordmark-colour.png` | 23014 | 1024 x 241 px | raster from TRACE. Transparent RGBA, width 1024 px; unchanged traced proportions. |
| `png/1024/kayas-wordmark-forest.png` | 23014 | 1024 x 241 px | raster from TRACE. Transparent RGBA, width 1024 px; unchanged traced proportions. |
| `png/1024/kayas-wordmark-white.png` | 22570 | 1024 x 241 px | raster from TRACE. Transparent RGBA, width 1024 px; unchanged traced proportions. |
| `png/2048/kayas-symbol-black.png` | 66616 | 2048 x 1619 px | raster from TRACE. Transparent RGBA, width 2048 px; unchanged traced proportions. |
| `png/2048/kayas-symbol-colour.png` | 79355 | 2048 x 1619 px | raster from TRACE. Transparent RGBA, width 2048 px; unchanged traced proportions. |
| `png/2048/kayas-symbol-forest.png` | 75743 | 2048 x 1619 px | raster from TRACE. Transparent RGBA, width 2048 px; unchanged traced proportions. |
| `png/2048/kayas-symbol-white.png` | 73771 | 2048 x 1619 px | raster from TRACE. Transparent RGBA, width 2048 px; unchanged traced proportions. |
| `png/2048/kayas-vertical-black.png` | 89531 | 2048 x 1753 px | raster from TRACE. Transparent RGBA, width 2048 px; unchanged traced proportions. |
| `png/2048/kayas-vertical-colour.png` | 104401 | 2048 x 1753 px | raster from TRACE. Transparent RGBA, width 2048 px; unchanged traced proportions. |
| `png/2048/kayas-vertical-forest.png` | 101946 | 2048 x 1753 px | raster from TRACE. Transparent RGBA, width 2048 px; unchanged traced proportions. |
| `png/2048/kayas-vertical-white.png` | 99451 | 2048 x 1753 px | raster from TRACE. Transparent RGBA, width 2048 px; unchanged traced proportions. |
| `png/4096/kayas-signature-black.png` | 103165 | 4096 x 895 px | raster from TRACE. Transparent RGBA, width 4096 px; unchanged traced proportions. |
| `png/4096/kayas-signature-colour.png` | 120667 | 4096 x 895 px | raster from TRACE. Transparent RGBA, width 4096 px; unchanged traced proportions. |
| `png/4096/kayas-signature-forest.png` | 117895 | 4096 x 895 px | raster from TRACE. Transparent RGBA, width 4096 px; unchanged traced proportions. |
| `png/4096/kayas-signature-white.png` | 114390 | 4096 x 895 px | raster from TRACE. Transparent RGBA, width 4096 px; unchanged traced proportions. |
| `png/4096/kayas-wordmark-black.png` | 103347 | 4096 x 961 px | raster from TRACE. Transparent RGBA, width 4096 px; unchanged traced proportions. |
| `png/4096/kayas-wordmark-colour.png` | 116856 | 4096 x 961 px | raster from TRACE. Transparent RGBA, width 4096 px; unchanged traced proportions. |
| `png/4096/kayas-wordmark-forest.png` | 116856 | 4096 x 961 px | raster from TRACE. Transparent RGBA, width 4096 px; unchanged traced proportions. |
| `png/4096/kayas-wordmark-white.png` | 113967 | 4096 x 961 px | raster from TRACE. Transparent RGBA, width 4096 px; unchanged traced proportions. |
| `png/512/kayas-signature-black.png` | 8146 | 512 x 112 px | raster from TRACE. Transparent RGBA, width 512 px; unchanged traced proportions. |
| `png/512/kayas-signature-colour.png` | 11191 | 512 x 112 px | raster from TRACE. Transparent RGBA, width 512 px; unchanged traced proportions. |
| `png/512/kayas-signature-forest.png` | 10797 | 512 x 112 px | raster from TRACE. Transparent RGBA, width 512 px; unchanged traced proportions. |
| `png/512/kayas-signature-white.png` | 10417 | 512 x 112 px | raster from TRACE. Transparent RGBA, width 512 px; unchanged traced proportions. |
| `png/512/kayas-symbol-black.png` | 13249 | 512 x 405 px | raster from TRACE. Transparent RGBA, width 512 px; unchanged traced proportions. |
| `png/512/kayas-symbol-colour.png` | 15818 | 512 x 405 px | raster from TRACE. Transparent RGBA, width 512 px; unchanged traced proportions. |
| `png/512/kayas-symbol-forest.png` | 14925 | 512 x 405 px | raster from TRACE. Transparent RGBA, width 512 px; unchanged traced proportions. |
| `png/512/kayas-symbol-white.png` | 14658 | 512 x 405 px | raster from TRACE. Transparent RGBA, width 512 px; unchanged traced proportions. |
| `png/512/kayas-vertical-black.png` | 16243 | 512 x 439 px | raster from TRACE. Transparent RGBA, width 512 px; unchanged traced proportions. |
| `png/512/kayas-vertical-colour.png` | 20887 | 512 x 439 px | raster from TRACE. Transparent RGBA, width 512 px; unchanged traced proportions. |
| `png/512/kayas-vertical-forest.png` | 20192 | 512 x 439 px | raster from TRACE. Transparent RGBA, width 512 px; unchanged traced proportions. |
| `png/512/kayas-vertical-white.png` | 19558 | 512 x 439 px | raster from TRACE. Transparent RGBA, width 512 px; unchanged traced proportions. |
| `png/512/kayas-wordmark-black.png` | 8365 | 512 x 121 px | raster from TRACE. Transparent RGBA, width 512 px; unchanged traced proportions. |
| `png/512/kayas-wordmark-colour.png` | 10438 | 512 x 121 px | raster from TRACE. Transparent RGBA, width 512 px; unchanged traced proportions. |
| `png/512/kayas-wordmark-forest.png` | 10438 | 512 x 121 px | raster from TRACE. Transparent RGBA, width 512 px; unchanged traced proportions. |
| `png/512/kayas-wordmark-white.png` | 9957 | 512 x 121 px | raster from TRACE. Transparent RGBA, width 512 px; unchanged traced proportions. |
| `qa/kayas-edge-checks.png` | 295591 | 1800 x 1400 px | raster QA / specimen. New transparent symbol and signature, all four colourways, on white / Forêt / Citron. |
| `qa/kayas-font-specimen.png` | 309679 | 2400 x 1800 px | raster QA / specimen. Samples actually rendered with Inter and Noto Naskh Arabic, 400 and 700; no Apple fonts. |
| `qa/kayas-icon-legibility-24.png` | 42059 | 1680 x 740 px | raster QA / specimen. 24 px tests at 1x and magnified; standard 20% and favicon 12.5% reserve. |
| `qa/kayas-trace-overlay-400.png` | 604577 | 15592 x 1450 px | raster QA / specimen. Source, flat vector trace and silhouette overlay at 4 pixels per native pixel; 50% coverage threshold. |
| `source/kayas-signature-source.png` | 204170 | 1278 x 279 px | source raster / NOT a clean export. Native 1278 x 279 legacy image retained for comparison only; contains the old matte fringe. |
| `svg/kayas-signature-black.svg` | 7160 | 1278 x 279.000000 units | vector TRACE. Editable cubic/line paths; no raster or font content. |
| `svg/kayas-signature-colour.svg` | 7723 | 1278 x 279.000000 units | vector TRACE. Editable cubic/line paths; no raster or font content. |
| `svg/kayas-signature-forest.svg` | 7161 | 1278 x 279.000000 units | vector TRACE. Editable cubic/line paths; no raster or font content. |
| `svg/kayas-signature-white.svg` | 7160 | 1278 x 279.000000 units | vector TRACE. Editable cubic/line paths; no raster or font content. |
| `svg/kayas-symbol-black.svg` | 2000 | 353 x 279.000000 units | vector TRACE. Editable cubic/line paths; no raster or font content. |
| `svg/kayas-symbol-colour.svg` | 2563 | 353 x 279.000000 units | vector TRACE. Editable cubic/line paths; no raster or font content. |
| `svg/kayas-symbol-forest.svg` | 2001 | 353 x 279.000000 units | vector TRACE. Editable cubic/line paths; no raster or font content. |
| `svg/kayas-symbol-white.svg` | 2000 | 353 x 279.000000 units | vector TRACE. Editable cubic/line paths; no raster or font content. |
| `svg/kayas-vertical-black.svg` | 7298 | 891 x 762.405689 units | vector TRACE. Editable cubic/line paths; no raster or font content. |
| `svg/kayas-vertical-colour.svg` | 7861 | 891 x 762.405689 units | vector TRACE. Editable cubic/line paths; no raster or font content. |
| `svg/kayas-vertical-forest.svg` | 7299 | 891 x 762.405689 units | vector TRACE. Editable cubic/line paths; no raster or font content. |
| `svg/kayas-vertical-white.svg` | 7298 | 891 x 762.405689 units | vector TRACE. Editable cubic/line paths; no raster or font content. |
| `svg/kayas-wordmark-black.svg` | 5557 | 891 x 209.000000 units | vector TRACE. Editable cubic/line paths; no raster or font content. |
| `svg/kayas-wordmark-colour.svg` | 5558 | 891 x 209.000000 units | vector TRACE. Editable cubic/line paths; no raster or font content. |
| `svg/kayas-wordmark-forest.svg` | 5558 | 891 x 209.000000 units | vector TRACE. Editable cubic/line paths; no raster or font content. |
| `svg/kayas-wordmark-white.svg` | 5557 | 891 x 209.000000 units | vector TRACE. Editable cubic/line paths; no raster or font content. |
| `README.md` | 28435 | - | Text; provenance, measured differences, usage, limitations and this inventory. |
