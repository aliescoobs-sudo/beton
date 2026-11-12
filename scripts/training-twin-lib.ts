// The decisions for the fictitious twin on the TRAINING instance (T11b), now bound to ONE explicit set of files (T10g, R19B-12).
// Before, the helper decided every pending label and discarded every open quarantine row it could list, so a second exercise that was staged at the same time
// lost its pending work silently. Now the caller names the set (its 64-hex sha, as the staging report prints it), sees a PREVIEW of the counts, and nothing is
// written without `apply`. Labels are not attributed to a set in the database (the label map is global), so label decisions are refused while ANY other set
// still has pending staging work; the quarantine rows of the named set alone can always be decided (`quarantineOnly`).
import type pg from 'pg';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate.ts';
import {
  decideLabel,
  decideQuarantine,
  type LabelKind,
  listLabels,
  listQuarantine,
  listStagedSets,
  type StagedSet,
} from '../src/modules/importer/index.ts';

export interface TwinScopePreview {
  setSha: string;
  openQuarantine: number;
  stagedBatches: number;
  pendingLabels: number;
  otherSets: StagedSet[];
}
export type TwinScopeResult =
  | { ok: true; preview: TwinScopePreview; applied: boolean; done: Record<string, number> }
  | { ok: false; reason: string; preview?: TwinScopePreview };

const KINDS: LabelKind[] = ['client', 'truck', 'driver', 'type', 'pump', 'category'];
const TYPES: Record<string, string | null> = { BB25: 'B25', B25HYD: 'B25' };
const CATS: Record<string, string> = {
  'REPARATION FICTIF': 'parts',
  'ENTRETIEN FICTIF': 'parts',
  'DIVERS FICTIF': 'other',
};

function labelDecision(kind: LabelKind, l: { key: string; uses: number }): Record<string, unknown> {
  if (kind === 'client') return { kind, key: l.key, status: l.uses >= 16 ? 'new' : 'label_only' };
  if (kind === 'truck') return { kind, key: l.key, status: 'unknown' };
  if (kind === 'driver') return { kind, key: l.key, status: 'label_only' };
  if (kind === 'type')
    return TYPES[l.key]
      ? { kind, key: l.key, status: 'mapped', canonical: TYPES[l.key] }
      : { kind, key: l.key, status: 'unknown' };
  if (kind === 'pump')
    return l.key === 'P SITRAD'
      ? { kind, key: l.key, status: 'mapped', canonical: 'pump' }
      : { kind, key: l.key, status: 'unknown' };
  return CATS[l.key]
    ? { kind, key: l.key, status: 'mapped', canonical: CATS[l.key] }
    : { kind, key: l.key, status: 'unknown' };
}

export async function previewTwinScope(
  appPool: pg.Pool,
  actor: SessionUser,
  setSha: string,
): Promise<TwinScopePreview | null> {
  const sets = await listStagedSets(appPool, actor);
  const mine = sets.find((s) => s.setSha === setSha);
  if (!mine) return null;
  let pendingLabels = 0;
  for (const kind of KINDS)
    pendingLabels += (await listLabels(appPool, actor, { kind, onlyOpen: true })).labels.length;
  return {
    setSha,
    openQuarantine: mine.openQuarantine,
    stagedBatches: mine.stagedBatches,
    pendingLabels,
    otherSets: sets.filter((s) => s.setSha !== setSha),
  };
}

export async function decideTwinScope(
  appPool: pg.Pool,
  actor: SessionUser,
  input: { setSha: string; apply: boolean; quarantineOnly: boolean },
): Promise<TwinScopeResult> {
  if (!/^[0-9a-f]{64}$/.test(input.setSha))
    return { ok: false, reason: 'the set must be given as its 64 lowercase hex characters (--set <sha>)' };
  const preview = await previewTwinScope(appPool, actor, input.setSha);
  if (!preview)
    return {
      ok: false,
      reason: 'no staged set with this sha has pending work (unknown set, or nothing left to decide)',
    };
  if (!input.quarantineOnly && preview.otherSets.length > 0)
    return {
      ok: false,
      preview,
      reason: `${preview.otherSets.length} other staged set(s) still have pending work (labels are global and cannot be attributed to one set): decide or roll back those first, or use --quarantine-only for this set's rows`,
    };
  const done: Record<string, number> = {};
  const bump = (k: string) => (done[k] = (done[k] ?? 0) + 1);
  if (!input.apply) return { ok: true, preview, applied: false, done };
  if (!input.quarantineOnly) {
    for (const kind of KINDS) {
      const { labels } = await listLabels(appPool, actor, { kind, onlyOpen: true });
      for (const l of labels) {
        const decision = labelDecision(kind, l);
        const r = await decideLabel(appPool, actor, decision);
        if (!r.ok) throw new Error(`decision refused for a ${kind} label: ${r.error}`);
        bump(`${kind}:${String(decision.status)}`);
      }
    }
  }
  for (const q of await listQuarantine(appPool, actor, { onlyOpen: true, setSha: input.setSha })) {
    if (q.setSha !== input.setSha)
      throw new Error('internal: a row of another set was returned for this scope');
    const r = await decideQuarantine(appPool, actor, { id: q.id, action: 'discard' });
    if (!r.ok) throw new Error(`quarantine decision refused: ${r.error}`);
    bump('quarantine:discard');
  }
  return { ok: true, preview, applied: true, done };
}
