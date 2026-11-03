import type { SurveyQuestion } from '@/modules/assistant';

/** One question per line: `yes_no: text`, `scale: text` (1 to 5) or `text: text`; ids are q1, q2... */
export function parseQuestions(raw: string): SurveyQuestion[] {
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 10)
    .map((line, i) => {
      const m = /^(yes_no|scale|text)\s*:\s*(.+)$/.exec(line);
      return {
        id: `q${i + 1}`,
        kind: (m?.[1] ?? 'text') as SurveyQuestion['kind'],
        text: (m?.[2] ?? line).slice(0, 200),
      };
    });
}
