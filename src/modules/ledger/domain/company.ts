import { z } from 'zod';
import { FOOTER, wrapFooter } from '@/lib/pdf/pdf';
import { err, ok, type Result } from '@/lib/result';
import { isRealDate } from './dates';

const text = (max: number) =>
  z
    .string()
    .transform((v) => v.trim().replace(/\s+/g, ' '))
    .pipe(z.string().min(1).max(max));
const optional = (max: number) =>
  z
    .string()
    .transform((v) => v.trim().replace(/\s+/g, ' '))
    .pipe(z.string().max(max))
    .nullish()
    .transform((v) => (v ? v : null));
/** Digits only: "181 780 0000 123..." typed with spaces is accepted. */
const digits = (n: number) =>
  z
    .string()
    .transform((v) => v.replace(/[\s.-]/g, ''))
    .pipe(z.string().regex(new RegExp(`^[0-9]{${n}}$`)));

const schema = z.object({
  /** Defaults to today in the service. */
  effectiveFrom: z.string().refine(isRealDate, 'date').nullish(),
  legalName: text(200),
  legalForm: text(60),
  ice: digits(15),
  ifNumber: text(30),
  rcNumber: text(40),
  patente: text(40),
  address: text(300),
  phone: optional(40),
  email: optional(200),
  rib: digits(24)
    .nullish()
    .or(z.literal('').transform(() => null)),
});

export type CompanyProfileInput = z.infer<typeof schema>;

export interface CompanyProfile {
  effectiveFrom: string;
  legalName: string;
  legalForm: string;
  ice: string;
  ifNumber: string;
  rcNumber: string;
  patente: string;
  address: string;
  phone: string | null;
  email: string | null;
  rib: string | null;
}

/**
 * Whether the legal block of the documents (legal name and form, ICE, RC, IF, patente, address and the RIB) fits its footer box on a page at
 * the printed size: it is refused here rather than clipped on an invoice.
 */
export function legalBlockFits(p: Omit<CompanyProfile, 'effectiveFrom'>): boolean {
  return wrapFooter(legalFooter({ effectiveFrom: '', ...p })).length <= FOOTER.maxLines;
}

export function parseCompanyProfileInput(
  input: unknown,
): Result<CompanyProfileInput, 'INVALID' | 'LEGAL_BLOCK_TOO_LONG'> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) return err('INVALID');
  const v = parsed.data;
  return legalBlockFits({ ...v, phone: v.phone ?? null, email: v.email ?? null, rib: v.rib ?? null })
    ? ok(v)
    : err('LEGAL_BLOCK_TOO_LONG');
}

/** "181780000012345678901234" → "181 780 000012345678901234 34"-style groups of the RIB: bank 3, branch 3, account 16, key 2. */
export function formatRib(rib: string): string {
  return rib.length === 24
    ? `${rib.slice(0, 3)} ${rib.slice(3, 6)} ${rib.slice(6, 22)} ${rib.slice(22)}`
    : rib;
}

/** Shown in the footer of a document when the owner has not filled the company profile yet. Never replaced by invented details. */
export const LEGAL_FOOTER_PLACEHOLDER = 'Coordonnées légales à renseigner (raison sociale, ICE, RC, adresse)';

/**
 * The legal footer of a document, from the owner-filled company profile only: "[raison sociale] - ICE / RC - [adresse]", then the other
 * registrations (and the RIB when the document shows it). Without a profile: the neutral placeholder.
 */
export function legalFooter(p: CompanyProfile | null): string[] {
  if (!p) return [LEGAL_FOOTER_PLACEHOLDER];
  return [
    `${p.legalName} (${p.legalForm}) - ICE ${p.ice} / RC ${p.rcNumber} - ${p.address}`,
    `IF ${p.ifNumber} · Patente ${p.patente}${p.rib ? ` · RIB ${formatRib(p.rib)}` : ''}`,
  ];
}

/** The lines printed at the head of a document: name and form, address, then the registrations. */
export function legalMentions(p: CompanyProfile): string[] {
  return [
    `${p.legalName} (${p.legalForm})`,
    p.address,
    `ICE ${p.ice} · IF ${p.ifNumber} · RC ${p.rcNumber} · Patente ${p.patente}`,
    ...(p.rib ? [`RIB ${formatRib(p.rib)}`] : []),
  ];
}
