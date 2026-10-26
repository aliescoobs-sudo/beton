import type { Role } from '@/modules/platform-security';
import { createPurchaseDraft } from './create-purchase';
import { invoiceFromBls } from './invoice-from-bls';
import { planOrder } from './plan-order';
import { recordPayment } from './record-payment';
import { recordReturn } from './record-return';
import type { DraftTool } from './types';

export const DRAFT_TOOLS: readonly DraftTool[] = [
  planOrder,
  recordPayment,
  createPurchaseDraft,
  recordReturn,
  invoiceFromBls,
];

export const findDraftTool = (name: string): DraftTool | undefined =>
  DRAFT_TOOLS.find((t) => t.name === name);
export const draftToolsFor = (role: Role): DraftTool[] => DRAFT_TOOLS.filter((t) => t.roles.includes(role));
