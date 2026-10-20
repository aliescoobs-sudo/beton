import { z } from 'zod';
import { err, ok, type Result } from '@/lib/result';
import {
  iceField,
  nameField,
  NOTES_MAX,
  paymentTermsField,
  phoneField,
  reasonField,
  textField,
} from './party';

export type ClientKind = 'company' | 'person';
export type ClientStatus = 'active' | 'archived';

export interface Client {
  id: string;
  /** CLT-nnn, generated, never changes. */
  code: string;
  name: string;
  kind: ClientKind;
  ice: string | null;
  /** Why this client shares its ICE with another one (owner/partner decision); null otherwise. */
  iceOverrideReason: string | null;
  phone: string | null;
  contactName: string | null;
  defaultZoneId: string | null;
  paymentTermsDays: number;
  notes: string | null;
  status: ClientStatus;
}

/** Only name and kind are required (AC-MD-01); everything else can be filled in later. */
const clientInputSchema = z
  .object({
    name: nameField,
    kind: z.enum(['company', 'person']),
    ice: iceField,
    phone: phoneField,
    contactName: textField(120),
    defaultZoneId: z.preprocess((v) => (v === '' ? undefined : v), z.uuid().optional()),
    paymentTermsDays: paymentTermsField,
    notes: textField(NOTES_MAX),
    /** Present only when someone with `parties.ice_override` accepts a second client on an existing ICE. */
    iceOverrideReason: reasonField,
  })
  .refine((input) => input.ice === undefined || input.kind === 'company', { path: ['ice'] });

export type ClientInput = z.infer<typeof clientInputSchema>;

export function parseClientInput(input: unknown): Result<ClientInput, 'INVALID'> {
  const parsed = clientInputSchema.safeParse(input);
  return parsed.success ? ok(parsed.data) : err('INVALID');
}
