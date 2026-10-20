/** Input and result of the owner's advance server action (`src/app/advance-action.ts`). */
export type AdvanceInput = { byDays: number } | { toDate: string; toTime: string };

export type AdvanceActionResult =
  | { ok: true; failedJob?: string }
  | {
      ok: false;
      error: 'UNAUTHENTICATED' | 'FORBIDDEN' | 'STEP_UP_REQUIRED' | 'REENROL_REQUIRED' | 'INVALID';
    };
