import type { AllowedType } from '@/lib/files/file-types';
import { err, ok, type Result } from '@/lib/result';

/**
 * What an AI reading of a supplier invoice photo may hand back: a draft the person checks and corrects in the normal entry
 * form (assisted entry only prefills, a human saves: DECISIONS 65). It never carries an amount computed by the model: the
 * lines are as printed, and the form's deterministic code computes every total.
 */
export interface InvoiceDraft {
  supplierInvoiceNo?: string;
  invoiceDate?: string;
  lines?: { description: string; qtyMilli?: number; unitPriceHtCentimes?: number }[];
}

export interface InvoiceExtractor {
  extract(file: { type: AllowedType; bytes: Uint8Array }): Promise<InvoiceDraft>;
}

export type ExtractionError = 'DISABLED' | 'NOT_AVAILABLE';

/**
 * The one door to the AI reading of an invoice (AC-INT-15). With the flag off (the default) it answers `DISABLED` before it
 * touches the file or any extractor: no network call, no model call, nothing leaves the server. With the flag on and no extractor
 * wired (the state of this release: only the interface exists) it answers `NOT_AVAILABLE`, still without a call. A provider will
 * be given as `extractor` only after the CNDP authorization, behind the pseudonymization of the AI layer (SPEC-ai-layer §3).
 */
export async function extractInvoiceDraft(
  config: { enabled: boolean; extractor?: InvoiceExtractor },
  file: { type: AllowedType; bytes: Uint8Array },
): Promise<Result<InvoiceDraft, ExtractionError>> {
  if (!config.enabled) return err('DISABLED');
  if (!config.extractor) return err('NOT_AVAILABLE');
  return ok(await config.extractor.extract(file));
}
