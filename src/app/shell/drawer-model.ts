import type { NavGroup } from './nav-model';

/**
 * The state logic of the phone drawer (an accordion), kept free of React so it is unit-tested. It never decides what a user may see: the groups
 * it is given were already filtered on the server by `buildNav` (permissions and module flags). Accordion state is UI state only.
 */

/** The link whose href is the longest prefix of the pathname ("/fr/master-data/clients/1" selects Clients; "/fr" only matches the home link). */
export function findCurrent(groups: NavGroup[], pathname: string) {
  return groups
    .flatMap((group) => group.links.map((link) => ({ group, link })))
    .filter(({ link }) => pathname === link.href || pathname.startsWith(`${link.href}/`))
    .sort((a, b) => b.link.href.length - a.link.href.length)[0];
}

/** A section with a single link is a plain link (no accordion). */
export const isDirect = (group: NavGroup) => group.links.length <= 1;

/** The section to open when the drawer opens: the one holding the current route, if it is an accordion section. */
export function initialOpenId(groups: NavGroup[], pathname: string): string | null {
  const group = findCurrent(groups, pathname)?.group;
  return group && !isDirect(group) ? group.id : null;
}

/** One section open at a time; tapping the open one closes it. */
export const toggleSection = (openId: string | null, id: string): string | null =>
  openId === id ? null : id;

const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase();

export interface FlatMatch {
  href: string;
  label: string;
  testId: string;
  groupLabel: string;
}

/** The links of every section whose label (or section name) contains the query, accents and case ignored; empty for a blank query. */
export function matchLinks(groups: NavGroup[], query: string): FlatMatch[] {
  const q = fold(query.trim());
  if (!q) return [];
  return groups.flatMap((group) =>
    group.links
      .filter((link) => fold(link.label).includes(q) || fold(group.label).includes(q))
      .map((link) => ({ href: link.href, label: link.label, testId: link.testId, groupLabel: group.label })),
  );
}
