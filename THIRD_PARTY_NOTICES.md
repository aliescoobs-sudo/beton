# Third-party notices

## Fonts (SIL Open Font License 1.1)

Both fonts are served by the application itself from `public/fonts/` (no external request). They are the unmodified upstream variable TTF files;
only the file names were changed. Their licence texts, with the copyright notices, are kept next to them and must stay shipped with them.

| Family | Use | Files | Upstream |
|---|---|---|---|
| Inter | Latin text, numbers and units (including m³) | `public/fonts/kayas-font-latin-variable.ttf`, licence `public/fonts/kayas-font-latin-license.txt` | https://github.com/rsms/inter ; https://github.com/google/fonts/tree/main/ofl/inter |
| Noto Naskh Arabic | Arabic text | `public/fonts/kayas-font-arabic-variable.ttf`, licence `public/fonts/kayas-font-arabic-license.txt` | https://github.com/notofonts/arabic ; https://github.com/google/fonts/tree/main/ofl/notonaskharabic |

SHA-256 of the bundled bytes: see `docs/brand/KAYAS-FLUX-TRACE-README.md` section 7 (checked by `src/ui/fonts.test.ts`).

No Apple font file (Helvetica Neue, Geeza Pro) is included. Their use in the brand guide was replaced on purpose by this pair (decision 204).
