import { describe, expect, it } from 'vitest';
import { isChosenAmountQuestion, mentionsAmount } from './chosen-amount';

const refused = (question: string, previous: string[] = []) => isChosenAmountQuestion({ question, previous });

describe('a user-chosen amount is refused (§16.4)', () => {
  it.each([
    'can we pay 50k?',
    'Est-ce qu’on peut payer 50 000 dh ce jeudi ?',
    'on peut payer 50k MAD au fournisseur ?',
    'هل نقدر نخلص 50 ألف درهم؟',
    'واش نقدرو ندفعو 40000 درهم',
    'is 120,000 MAD covered next week?',
    'si on paie 80 mille, il reste assez ?',
  ])('refuses: %s', (q) => expect(refused(q)).toBe(true));

  it.each(['and 40k?', 'et 40 000 ?', 'و 40 ألف؟'])('refuses the follow-up fragment: %s', (q) =>
    expect(refused(q, ['can we pay 50k?'])).toBe(true),
  );

  it('does not treat a bare fragment as a chosen amount without a previous question', () => {
    expect(refused('40k?')).toBe(false);
  });

  it.each([
    'cheque CHQ-000123 due Thursday: covered, tight or needs action?',
    'quand est la prochaine échéance du client CLT-014 ?',
    'what is the status of order CMD-2026-00045?',
    'montre les livraisons du 2026-11-02',
    'combien de m³ livrés cette semaine ?',
    'stock de ciment à Tétouan ?',
    'ما هي حالة الشيك المستحق يوم الخميس؟',
  ])('answers: %s', (q) => expect(refused(q)).toBe(false));

  it('mentionsAmount ignores codes and dates', () => {
    expect(mentionsAmount('BL-2026-00012 on 2026-11-02')).toBe(false);
    expect(mentionsAmount('50 000 dh')).toBe(true);
    expect(mentionsAmount('50k')).toBe(true);
  });
});
