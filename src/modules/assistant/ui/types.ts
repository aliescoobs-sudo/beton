import type { ProposalCard } from '../domain/drafts';

export type Card = ProposalCard;

/** What the endpoint answers to a question (SPEC-assistant §3): the same as the service's `TurnResult`, as JSON. */
export interface TurnResponse {
  interactionId: string;
  outcome: string;
  answer: string | null;
  fallback: boolean;
  refusal: string | null;
  chips: { tool: string; outcome: string; rows: number }[];
  results: { tool: string; data: unknown }[];
  sent: { system: string; messages: { role: string; content: string; toolCalls?: unknown }[] } | null;
  proposals: Card[];
  budgetPercent: number;
}

export const SUGGESTION_COUNT: Record<string, number> = {
  owner: 5,
  partner: 3,
  office: 4,
  plant: 4,
  support: 3,
};
