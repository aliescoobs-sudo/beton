import { z } from 'zod';
import type { LlmToolSpec } from '@/lib/ai/llm-provider';
import type { Role } from '@/modules/platform-security';
import type { AssistantTool } from '../domain/tool-types';
import { deliveriesToday } from './tools/deliveries-today';
import { forecast } from './tools/forecast';
import { nextLoad } from './tools/next-load';
import { openInvoices } from './tools/open-invoices';
import { stockAndCover } from './tools/stock-and-cover';
import { uninvoicedBls } from './tools/uninvoiced-bls';

/** The catalogue (SPEC-assistant §5). Fixed in code: the model cannot add a tool, and a role sees only its own column. */
export const TOOLS: readonly AssistantTool[] = [
  deliveriesToday,
  stockAndCover,
  uninvoicedBls,
  openInvoices,
  forecast,
  nextLoad,
];

export const findTool = (name: string): AssistantTool | undefined => TOOLS.find((t) => t.name === name);

/** The tools a role may be offered: not in the list sent to the model means not callable (defence in depth at call time). */
export const toolsFor = (role: Role): AssistantTool[] => TOOLS.filter((t) => t.roles.includes(role));

export function toolSpecsFor(role: Role): LlmToolSpec[] {
  return toolsFor(role).map((t) => ({
    name: t.name,
    description: t.description,
    parameters: z.toJSONSchema(t.params) as Record<string, unknown>,
  }));
}
