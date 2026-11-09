# T9b (done, option B1): what reads "delivered", and what a driver's tap may touch (audit, 9 Nov 2026)

Owner's decision 206, option B: a driver's `unloading_finished` MAY mark the trip/load delivered again (operational status), but nothing billable or
stock-related may derive from a driver tap: the billable quantity, the stock consumption and "A facturer" come only from the plant's own batch/dispatch record.

## 1. The two things that exist today

- **The plant's record**: the `delivery` row (BL, `volume_l`) made by the plant's load (`createLoadInTx`), with its `stock_movement` rows. It is the only source of every
  quantity below. A driver tap has never written it, and (since T9) cannot.
- **The delivered mark**: a row in `delivery_delivered` for that `delivery` (what the screens call "livré"). It is a gate (a boolean per load), not a quantity.

## 2. Every reader of "delivered", and where its quantity comes from

| Reader | Migration / code | Reads "delivered" as | Quantity source |
|---|---|---|---|
| Invoice queue "A facturer" | 0066 `invoice_queue` | gate: only delivered loads | `delivery.volume_l` (plant record) |
| Invoice from deliveries (create, lines, totals) | 0067 | gate: refuses a load that is not delivered (`delivery_delivered` exists) | `delivery.volume_l` x price |
| Order chain: "livré", "facturé", "payé" per order | 0073, 0095, `order-chain-service` | `delivered_l` = sum of delivered loads | `delivery.volume_l` |
| Orders list "Livré / commande" | `order-read.ts` via the `delivered_load` view | sum of delivered loads | `delivery.volume_l` |
| Customer statements / balances | built from invoices | none directly (invoices only) | invoices, hence plant record |
| Plant flows: loads not yet delivered / returned | 0094, `plant-views` | "on the road" = not delivered | `delivery.volume_l` |
| Day close | 0107 | undelivered loads are an exception to close | `delivery.volume_l` |
| Fuel per m3 | `fuel.ts` (reads deliveries, not the mark) | not used | `delivery.volume_l` |
| Stock | `stock_movement` written with the load | not used | recette x `volume_l` of the plant record |
| Alerts / late departure / "etape plus longue" | `trip_delay`, `trip_event` times | not used | none (times only) |

**Finding:** no money or stock figure derives from a driver-declared event today. The quantity of every one of them is the plant's `delivery` row. The only
coupling is the **gate**: a load becomes eligible for "A facturer" and for an invoice when its delivered mark exists. Under the rule of 0064 that mark was set by
ANY writer's `unloading_finished`, a driver's included. So under the old rule a driver's tap decided WHEN a plant-recorded load became billable (never how much).

## 3. What option B changes, and the one real question

- Re-enabling the mark from a driver's `unloading_finished` is a one-line reversal of my change to `trip_event_delivered()` (migration 0209 §5). The quantity stays the
  plant's. A driver-declared delivery with NO plant load has no `delivery` row, so it can never reach "A facturer" or an invoice (nothing to bill, nothing to consume).
- **Open point (stop condition of the task):** with that reversal, the *eligibility moment* of a plant-recorded load to be invoiced still follows a driver's tap.
  "Nothing billable derives from a driver tap" can be read as covering that. Making eligibility depend on the plant only means changing the invoice gate
  (0066/0067, accounting logic), which the task says to stop and report rather than guess.

## 4. Options (owner to choose)

- **B1 (smallest, no accounting change):** the driver's tap sets the operational "livré" (a flag the screens show), but the existing gate in 0066/0067 keeps reading
  `delivery_delivered`, which is written only by the plant's own stage or its confirmation. Two marks: `delivered` (operational, shared) and `delivery_delivered`
  (billing gate, plant only). The orders list shows the operational one with "declare par le chauffeur"; "A facturer" and invoices read the plant's.
- **B2 (literal reading):** the driver's tap writes `delivery_delivered` again (as 0064), the quantity is always the plant record, and a driver-declared delivery with no
  plant record is shown as an exception ("declare par le chauffeur"), excluded from billing because it has no `delivery` row. Billing eligibility then follows the driver's tap.
- **Not in either option:** a bulk-confirm screen (removed by the owner's decision).

Whatever is chosen, the same additions apply: the exception list for the plant manager and the owner's dashboard (driver-declared delivery with no plant record; plant
quantity different from the order or from the volume the driver declared, flagged and never auto-corrected), the fr/ar labels, and the tests listed in the task
(a driver tap changes no stock row, invoice figure or "A facturer" amount; billable quantity = plant record; cross-plant denial).
