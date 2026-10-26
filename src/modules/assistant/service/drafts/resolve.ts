import { listClients, listConcreteTypes, listSiteOptions, listSuppliers } from '@/modules/master-data';
import { nameWords } from '../../domain/normalize';
import type { ExecContext } from './types';

type Who = Pick<ExecContext, 'appPool' | 'actor'>;

/** A client by its code, active: read under the person's own row-level security. */
export async function clientByCode(who: Who, code: string) {
  const found = (await listClients(who.appPool, who.actor)).find((c) => c.code === code);
  return found && found.status === 'active' ? found : null;
}

export async function supplierByCode(who: Who, code: string) {
  const found = (await listSuppliers(who.appPool, who.actor)).find((s) => s.code === code);
  return found && found.status === 'active' ? found : null;
}

export async function concreteTypeByCode(who: Who, code: string) {
  const found = (await listConcreteTypes(who.appPool, who.actor)).find(
    (t) => t.code.toUpperCase() === code.toUpperCase(),
  );
  return found && found.status === 'active' ? found : null;
}

/**
 * The sites of a client are named by code, `SITE-<client number>-<n>`: the n-th by label (the order the order form offers).
 * A site's name is personal, so the model only ever sees this code (the pre-pass maps the name the person types to it).
 */
export function siteCodesOf(
  sites: { id: string; clientId: string; label: string }[],
  clients: { id: string; code: string }[],
): { code: string; id: string; label: string; clientCode: string }[] {
  const numberOf = new Map(clients.map((c) => [c.id, c.code.replace(/^CLT-/, '')]));
  const byClient = new Map<string, typeof sites>();
  for (const s of sites) byClient.set(s.clientId, [...(byClient.get(s.clientId) ?? []), s]);
  const out: { code: string; id: string; label: string; clientCode: string }[] = [];
  for (const [clientId, list] of byClient) {
    const number = numberOf.get(clientId);
    if (!number) continue;
    [...list]
      .sort((a, b) => a.label.toLowerCase().localeCompare(b.label.toLowerCase()))
      .forEach((s, i) =>
        out.push({ code: `SITE-${number}-${i + 1}`, id: s.id, label: s.label, clientCode: `CLT-${number}` }),
      );
  }
  return out;
}

export async function siteByCode(who: Who, code: string) {
  const [sites, clients] = await Promise.all([
    listSiteOptions(who.appPool, who.actor),
    listClients(who.appPool, who.actor),
  ]);
  return siteCodesOf(sites, clients).find((s) => s.code === code) ?? null;
}

/** A name typed in any case or script, to compare with another. */
export const sameName = (a: string, b: string): boolean => nameWords(a).join(' ') === nameWords(b).join(' ');
