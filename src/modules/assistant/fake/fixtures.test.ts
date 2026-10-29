import { describe, expect, it } from 'vitest';
import { Pseudonymizer } from '../domain/pseudonymizer';
import { draftToolsFor } from '../service/drafts/registry';
import { toolsFor } from '../service/tool-registry';
import { FIXTURE_ENTITIES, FIXTURE_TODAY, FIXTURES, type Fixture } from './fixtures';
import { routeQuestion } from './route';

const ROLES = ['owner', 'partner', 'office', 'plant', 'support'] as const;
const offered = (role: (typeof ROLES)[number]) =>
  [...toolsFor(role), ...draftToolsFor(role)].map((t) => t.name);

/** What the scripted provider does with a fixture: the tool it calls and its arguments, after the same pre-pass as a real turn. */
function run(fx: Fixture) {
  const masked = new Pseudonymizer(FIXTURE_ENTITIES).maskQuestion(fx.question);
  return routeQuestion(masked, offered(fx.role), { today: FIXTURE_TODAY });
}

const matches = (fx: Fixture): boolean => {
  const got = run(fx);
  if (fx.tool === null) return got === null;
  if (!got || got.name !== fx.tool) return false;
  return Object.entries(fx.args ?? {}).every(([k, v]) => JSON.stringify(got.args[k]) === JSON.stringify(v));
};

describe('the French and Darija evaluation set (AC-ASSIST-18)', () => {
  it('has twenty questions per role, with French, Arabic and Darija in each', () => {
    for (const role of ROLES) {
      const set = FIXTURES.filter((x) => x.role === role);
      expect(set, role).toHaveLength(20);
      expect(new Set(set.map((x) => x.lang)), role).toEqual(new Set(['fr', 'ar', 'darija']));
      expect(set.filter((x) => x.lang !== 'fr').length, role).toBeGreaterThanOrEqual(4);
    }
  });

  it.each(ROLES)(
    'selects the right tool with the right arguments for at least 18 of 20 questions, for the %s',
    (role) => {
      const set = FIXTURES.filter((x) => x.role === role);
      const failed = set.filter((x) => !matches(x));
      expect(
        failed.map((x) => `${x.question} → ${JSON.stringify(run(x))}`),
        role,
      ).toEqual([]);
      expect(set.length - failed.length).toBeGreaterThanOrEqual(18);
    },
  );

  it('covers every tool of every role at least once, and one refusal where the role lacks a tool', () => {
    for (const role of ROLES) {
      const set = FIXTURES.filter((x) => x.role === role);
      for (const name of offered(role))
        expect(
          set.some((x) => x.tool === name),
          `${role}: ${name}`,
        ).toBe(true);
    }
    for (const role of ['office', 'plant', 'partner', 'support'] as const)
      expect(
        FIXTURES.some((x) => x.role === role && x.tool === null),
        role,
      ).toBe(true);
  });

  it('never calls a tool the role is not offered, whatever the question', () => {
    for (const fx of FIXTURES) {
      const got = run({ ...fx, tool: fx.tool });
      if (got) expect(offered(fx.role), `${fx.role}: ${fx.question}`).toContain(got.name);
    }
  });

  it('keeps every name of the questions out of the arguments: codes and references only', () => {
    for (const fx of FIXTURES) {
      const got = run(fx);
      if (got)
        expect(JSON.stringify(got.args), fx.question).not.toMatch(
          /Atlas|Martil|Ciments du Nord|8451237|45 000/,
        );
    }
  });
});
