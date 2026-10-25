import { z } from 'zod';
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

export function parseCompanyProfileInput(input: unknown): Result<CompanyProfileInput, 'INVALID'> {
  const parsed = schema.safeParse(input);
  return parsed.success ? ok(parsed.data) : err('INVALID');
}

/** "181780000012345678901234" → "181 780 000012345678901234 34"-style groups of the RIB: bank 3, branch 3, account 16, key 2. */
export function formatRib(rib: string): string {
  return rib.length === 24
    ? `${rib.slice(0, 3)} ${rib.slice(3, 6)} ${rib.slice(6, 22)} ${rib.slice(22)}`
    : rib;
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
