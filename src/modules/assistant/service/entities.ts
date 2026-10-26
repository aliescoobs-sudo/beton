import { listClients, listSuppliers } from '@/modules/master-data';
import { can } from '@/modules/platform-security';
import type { EntityRef } from '../domain/pseudonymizer';
import type { ToolContext } from '../domain/tool-types';

/**
 * The clients and suppliers this person may read under their own row-level security, by code (SPEC-assistant §4): the pre-pass
 * turns the names they type into these codes, and the answer shows these names back. A role that reads none (the plant) has none,
 * so a name it types is not masked here and is caught by the leak scan instead, which knows every name.
 */
export async function visibleEntities(ctx: Pick<ToolContext, 'appPool' | 'actor'>): Promise<EntityRef[]> {
  const entities: EntityRef[] = [];
  if (can(ctx.actor.role, 'parties.read')) {
    for (const c of await listClients(ctx.appPool, ctx.actor))
      entities.push({ code: c.code, names: [c.name] });
    for (const s of await listSuppliers(ctx.appPool, ctx.actor))
      entities.push({ code: s.code, names: [s.name] });
  }
  return entities;
}
