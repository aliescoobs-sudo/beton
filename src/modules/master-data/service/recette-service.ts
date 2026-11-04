import type pg from 'pg';
import { err, ok, type Result } from '@/lib/result';
import { uuidv7 } from '@/lib/uuidv7';
import { realClock } from '@/modules/clock';
import { projectMany, project, type SessionUser } from '@/modules/platform-security';
import {
  parseRecetteInput,
  recetteVisibility,
  resolveRecetteForPlant,
  type Recette,
  type RecetteView,
} from '../domain/recette';
import { inRequest, isMalformedId, require } from './request';

export type RecetteError = 'INVALID' | 'NOT_FOUND' | 'NOT_AFTER_LATEST' | 'INACTIVE_COMPONENT' | 'CONFLICT';

interface RecetteRow {
  id: string;
  concrete_type_id: string;
  version: number;
  plant_id: string | null;
  effective_from: string;
  lines: { componentId: string; qtyPerM3: string }[];
}

// `date` is read as text so the business date is never shifted by a time zone.
const SELECT = `
  select r.id, r.concrete_type_id, r.version, r.plant_id, to_char(r.effective_from, 'YYYY-MM-DD') as effective_from,
         coalesce(json_agg(json_build_object('componentId', l.component_id, 'qtyPerM3', l.qty_per_m3::text)
                           order by c.code) filter (where l.id is not null), '[]') as lines
    from recette r
    left join recette_line l on l.recette_id = r.id
    left join component c on c.id = l.component_id`;

const toRecette = (row: RecetteRow): Recette => ({
  id: row.id,
  concreteTypeId: row.concrete_type_id,
  version: row.version,
  plantId: row.plant_id,
  effectiveFrom: row.effective_from,
  lines: row.lines.map((l) => ({ componentId: l.componentId, qtyPerM3: Number(l.qtyPerM3) })),
});

/** Every version of one concrete type, newest first, as the actor's role may see it (no cost for office/plant). */
export async function listRecetteVersions(
  appPool: pg.Pool,
  actor: SessionUser,
  concreteTypeId: string,
): Promise<Recette[]> {
  await require(appPool, actor, 'recettes.read');
  try {
    const { rows } = await inRequest(appPool, actor, (tx) =>
      tx.query<RecetteRow>(`${SELECT} where r.concrete_type_id = $1 group by r.id order by r.version desc`, [
        concreteTypeId,
      ]),
    );
    return projectMany<RecetteView>(recetteVisibility, actor.role, rows.map(toRecette)) as Recette[];
  } catch (error) {
    if (isMalformedId(error)) return [];
    throw error;
  }
}

/**
 * The recette of a type in force on a business date for a plant (the plant's own mix, else the all-plants one); with no
 * plant, the all-plants mix. An order stores the returned id.
 */
export async function resolveRecetteFor(
  appPool: pg.Pool,
  actor: SessionUser,
  concreteTypeId: string,
  date: string,
  plantId: string | null = null,
): Promise<Result<Recette, 'NO_RECETTE'>> {
  return resolveRecetteForPlant(await listRecetteVersions(appPool, actor, concreteTypeId), date, plantId);
}

/** Publishes the next version of a type (insert-only: the old version is untouched). */
export async function createRecetteVersion(
  appPool: pg.Pool,
  actor: SessionUser,
  concreteTypeId: string,
  input: unknown,
): Promise<Result<Recette, RecetteError>> {
  await require(appPool, actor, 'recettes.write');
  const parsed = parseRecetteInput(input);
  if (!parsed.ok) return err('INVALID');
  const { effectiveFrom, lines } = parsed.value;
  const plantId = parsed.value.plantId ?? null;
  try {
    return await inRequest(appPool, actor, async (tx): Promise<Result<Recette, RecetteError>> => {
      const type = await tx.query(`select 1 from concrete_type where id = $1`, [concreteTypeId]);
      if (!type.rows[0]) return err('NOT_FOUND');
      const active = await tx.query<{ n: string }>(
        `select count(*) as n from component where id = any($1::uuid[]) and status = 'active'`,
        [lines.map((l) => l.componentId)],
      );
      if (Number(active.rows[0]?.n) !== lines.length) return err('INACTIVE_COMPONENT');
      if (plantId) {
        const plant = await tx.query(`select 1 from plant where id = $1 and status = 'active'`, [plantId]);
        if (!plant.rows[0]) return err('NOT_FOUND');
      }
      const id = uuidv7(realClock.now());
      const { rows } = await tx.query<{ version: number }>(
        `insert into recette (id, concrete_type_id, plant_id, version, effective_from, created_by)
         values ($1, $2, $5, (select coalesce(max(version), 0) + 1 from recette
                               where concrete_type_id = $2 and plant_id is not distinct from $5::uuid), $3, $4)
         returning version`,
        [id, concreteTypeId, effectiveFrom, actor.id, plantId],
      );
      for (const line of lines) {
        await tx.query(
          `insert into recette_line (id, recette_id, component_id, qty_per_m3) values ($1, $2, $3, $4)`,
          [uuidv7(realClock.now()), id, line.componentId, line.qtyPerM3],
        );
      }
      const created: RecetteView = {
        id,
        concreteTypeId,
        version: (rows[0] as { version: number }).version,
        plantId,
        effectiveFrom,
        lines,
      };
      return ok(project(recetteVisibility, actor.role, created) as Recette);
    });
  } catch (error) {
    const code = (error as { code?: string }).code;
    // check_violation (trigger: date not after the previous version) and unique (same date, same version).
    if (code === '23514' || code === '23505') return err('NOT_AFTER_LATEST');
    if (code === '40001') return err('CONFLICT');
    if (code === '22P02') return err('NOT_FOUND');
    throw error;
  }
}
