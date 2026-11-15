# T18-UI report: final look and feel pass

Fictitious data only. UI only: no migration, no door, no permission change. Decision 244.

## What changed, per scope item

**A. Tokens and shell.** `src/app/tokens.css` is now the one tokens file (colours, spacing, radius, type scale with body 16 px / line height 1.5, focus ring, touch target). `globals.css` imports it. Light mode complete; dark mode derived from the same tokens, measured by `src/ui/brand-contrast.test.ts` (reads the tokens file). Shell: the prototype's organisation is a top bar with group tabs and a page band (not a sidebar), kept and completed with a phone bottom bar (home + up to 3 groups, labelled icons, 24 px / 1.6 stroke, >= 56 px tall) and the existing drawer under Menu. The bar reuses the groups `buildNav` already filtered per role: no permission touched. Tablet uses the desktop tabs from md up.

**B. Homes.** Owner / app_admin: new "L'essentiel en cinq secondes" strip (3 cards: collected, total with not yet collected, issued cheques not debited) with red alert cards only when a real fact exists (black day, client arrears, loading excesses, open alerts), each linked to its section; the forecast curve and the other blocks follow. Plant manager / office: a 3-card strip (loads to make, remaining m³, stock alerts), no amount. Driver: the phone app was already phone-first (big targets, Forêt buttons); only its sign-in screen is screenshotted (the signed-in driver home needs seeded trips).

**C. Lists.** New kit in `src/ui/list-kit.tsx` + `list-model.ts` (unit-tested): filters row (GET form, apply, reset), status chips (with a check mark, not colour alone), sortable headers with `aria-sort` (only declared columns are accepted), pagination, empty state, no-match state, `LoadingState`, `ErrorState`, `ExportButton`. Applied to: orders (search, status chips, sort, pagination), margins (filters, paginated BL table), pump-check (filters, kind chips), fuel-check (filters, state chips, sort, pagination). Route-level `error.tsx` gives every signed-in screen an error state with retry.

**D. Order flow.** `OrderForm` is now Panier, Livraison, Récapitulatif (stepper, back/next, step 1 validated before advancing). Same state, same `build()` validation, same doors; the discharge method selector stays required with no default. Wished hour and client PO number are shown disabled with "not available yet".

**E. Languages.** fr and ar keys added (`list`, `shell.nav.skip/bottom`, `ledger.orders.flow`, `dashboard.five`, `dashboard.ops.kpi`); Darija falls back to Arabic through the existing overlay (nothing rewritten). The e2e spec checks `dir="rtl"`, no sideways scroll at 375 px on every order step and list in ar, numbers in `bdi dir="ltr"`.

**F. Accessibility / phone.** Skip link, `main` landmark, SVG bell replaces an emoji, 44 px for menu, user menu, bell and bottom bar (asserted in e2e), visible 3 px focus ring from tokens, `prefers-reduced-motion` rule, aria labels on nav landmarks and icon controls.

**G. Brand.** No visible trace of the former product name: the existing `scripts/brand-guard.test.ts` (UI, manifests, PDFs) stays green; remaining hits are internal database role names, allowed legacy. Descriptor stays separate text. No external request: `e2e/t18-ui.spec.ts` records every request on owner, office, plant and driver screens.

## Prototype elements with no backend yet
- Wished delivery hour and client PO number (order step 2): disabled with note.
- Order lifecycle statuses Created / Confirmed / In process / Delivered / Done: only the derived states (open, late, settled, cancelled) exist.
- Card "unbilled deliveries" and the monthly consumption curve with drill-down: no data source (no new one allowed); the daily forecast curve is kept.
- Complete BL view with GPS tracking, "see more" on every block, Excel export on every list: only the three existing exports (accounting, finance, statements) exist; none built.
- Prototype assistant side panel and simulation strip: not restyled.

## Contrast
No measurement failed; the new pairs reuse measured tokens (white on Forêt 8.52, Graphite on Citron, status red on surface for the alert mark which is also text-labelled). Prototype colours were not imported, which avoids its failures (e.g. its blue focus).

## Remaining gaps
- The list kit is applied to 4 screens; clients, suppliers, trucks, prices, recipes (client-component managers), BL/loads, audit, parameters and finance screens keep their current tables (already card-style on phone) and need the kit applied in a follow-up.
- Sort/filter/pagination run in memory after the door returns the set (no server-side paging).
- Dark mode follows the OS only (no manual switch); not screenshotted.
- Tablet has no dedicated layout (desktop tabs from 768 px).
- Driver signed-in home not restyled or screenshotted.
- Screenshots: home owner/plant/office x fr/ar x desktop/phone, order flow 1-3 (fr) + step 1 (ar), orders list with filters, margins, pump-check, driver sign-in. Re-run with `UI_SCREENSHOTS=1` (needs the earlier specs' data in a full run; the pilot seed alone suffices).
