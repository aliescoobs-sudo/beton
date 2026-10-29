'use client';

import { useTranslations } from 'next-intl';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { DraftCard } from './draft-card';
import { isolate } from './isolate';
import { ResultView } from './result-view';
import { type Card, SUGGESTION_COUNT, type TurnResponse } from './types';

type Entry =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; turn: TurnResponse }
  | { kind: 'error'; text: string };

/**
 * The assistant, from every screen (SPEC-assistant §1): a button in the top bar and a panel beside the page, in the user's language,
 * with the questions that suit their role. Each answer shows the tools it used and, on demand, exactly what was sent to the AI;
 * a draft is a card the person confirms. The conversation lives in this page's memory only: closing the tab forgets it.
 */
export function AssistantPanel({ role }: { role: string }) {
  const t = useTranslations('assistant');
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [cards, setCards] = useState<Record<string, Card>>({});
  const [pending, setPending] = useState(false);
  const [budget, setBudget] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const loaded = useRef(false);

  useEffect(() => {
    if (!open) return;
    input.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('keydown', onKey);
    if (!loaded.current) {
      loaded.current = true;
      void fetch('/api/assistant/proposals')
        .then((r) => (r.ok ? r.json() : null))
        .then((b: { proposals?: Card[] } | null) => {
          if (b?.proposals)
            setCards((prev) => ({ ...Object.fromEntries(b.proposals!.map((c) => [c.id, c])), ...prev }));
        })
        .catch(() => undefined);
    }
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight });
  }, [entries, pending]);

  const shownIds = new Set(
    entries.flatMap((e) => (e.kind === 'assistant' ? e.turn.proposals.map((p) => p.id) : [])),
  );
  const waiting = Object.values(cards).filter((c) => c.status === 'pending' && !shownIds.has(c.id));

  async function ask(question: string) {
    const q = question.trim();
    if (!q || pending) return;
    setPending(true);
    const history = entries.flatMap((e, i) => {
      const next = entries[i + 1];
      return e.kind === 'user' && next?.kind === 'assistant'
        ? [{ question: e.text, answer: next.turn.answer ?? '' }]
        : [];
    });
    setEntries((prev) => [...prev, { kind: 'user', text: q }]);
    try {
      const res = await fetch('/api/assistant/ask', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: q, history: history.slice(-10) }),
      });
      const body = (await res.json().catch(() => null)) as TurnResponse | null;
      if (res.ok && body) {
        setBudget(body.budgetPercent);
        setCards((prev) => ({ ...prev, ...Object.fromEntries(body.proposals.map((c) => [c.id, c])) }));
        setEntries((prev) => [...prev, { kind: 'assistant', turn: body }]);
      } else
        setEntries((prev) => [
          ...prev,
          { kind: 'error', text: res.status === 503 ? t('refusal.unavailable') : t('error.generic') },
        ]);
    } catch {
      setEntries((prev) => [...prev, { kind: 'error', text: t('error.network') }]);
    } finally {
      setPending(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const q = input.current?.value ?? '';
    if (input.current) input.current.value = '';
    void ask(q);
  }

  const suggestions = Array.from({ length: SUGGESTION_COUNT[role] ?? 0 }, (_, i) =>
    t(`suggestions.${role}.s${i + 1}` as never),
  );
  const update = (card: Card) => setCards((prev) => ({ ...prev, [card.id]: card }));

  return (
    <>
      <button
        type="button"
        className="px-2 py-1 text-sm font-medium underline decoration-2 underline-offset-4"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="assistant-panel"
        data-testid="assistant-open"
      >
        {t('open')}
      </button>
      {open && (
        <div
          id="assistant-panel"
          role="dialog"
          aria-modal="false"
          aria-label={t('title')}
          data-testid="assistant-panel"
          className="fixed inset-y-0 end-0 z-50 flex w-full flex-col border-s border-rule bg-white text-ink shadow-xl sm:w-[26rem]"
        >
          <header className="flex items-center justify-between gap-2 border-b border-rule px-4 py-3">
            <h2 className="text-lg font-semibold">{t('title')}</h2>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setOpen(false)}
              data-testid="assistant-close"
            >
              {t('close')}
            </button>
          </header>
          <p className="border-b border-rule px-4 py-2 text-xs text-muted">{t('notice')}</p>
          {budget >= 80 && role === 'owner' && (
            <p className="border-b border-rule px-4 py-2 text-xs" data-testid="assistant-budget">
              {t('budget80', { percent: budget })}
            </p>
          )}
          <div
            ref={log}
            className="flex-1 space-y-4 overflow-y-auto px-4 py-3"
            aria-live="polite"
            data-testid="assistant-log"
          >
            {entries.length === 0 && suggestions.length > 0 && (
              <div>
                <p className="mb-2 text-sm font-medium">{t('suggestionsTitle')}</p>
                <ul className="space-y-1.5">
                  {suggestions.map((s, i) => (
                    <li key={i}>
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm w-full whitespace-normal text-start"
                        onClick={() => void ask(s)}
                        data-testid={`assistant-suggestion-${i + 1}`}
                      >
                        {s}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {waiting.map((c) => (
              <DraftCard key={c.id} card={c} onChange={update} />
            ))}
            {entries.map((e, i) =>
              e.kind === 'user' ? (
                <div
                  key={i}
                  className="ms-8 bg-ink px-3 py-2 text-sm text-white"
                  data-testid="assistant-question"
                >
                  <p dir="auto">{e.text}</p>
                </div>
              ) : e.kind === 'error' ? (
                <p key={i} role="alert" className="text-sm">
                  {e.text}
                </p>
              ) : (
                <TurnView key={i} turn={e.turn} cards={cards} onCard={update} />
              ),
            )}
            {pending && (
              <p className="text-sm text-muted" data-testid="assistant-thinking">
                {t('thinking')}
              </p>
            )}
          </div>
          <form onSubmit={submit} className="flex gap-2 border-t border-rule p-3">
            <input
              ref={input}
              name="question"
              maxLength={600}
              autoComplete="off"
              dir="auto"
              required
              aria-label={t('questionLabel')}
              placeholder={t('placeholder')}
              className="input flex-1"
              data-testid="assistant-input"
            />
            <button type="submit" className="btn btn-primary" disabled={pending} data-testid="assistant-send">
              {t('send')}
            </button>
          </form>
        </div>
      )}
    </>
  );
}

function TurnView({
  turn,
  cards,
  onCard,
}: {
  turn: TurnResponse;
  cards: Record<string, Card>;
  onCard: (c: Card) => void;
}) {
  const t = useTranslations('assistant');
  return (
    <div
      className="space-y-2 border border-rule p-3 text-sm"
      data-testid="assistant-answer-block"
      data-outcome={turn.outcome}
    >
      {turn.refusal ? (
        <p data-testid="assistant-refusal">{t(`refusal.${turn.refusal}` as never)}</p>
      ) : turn.answer ? (
        <p dir="auto" className="whitespace-pre-wrap" data-testid="assistant-answer">
          {isolate(turn.answer)}
        </p>
      ) : turn.fallback && turn.results.length > 0 ? (
        <div data-testid="assistant-fallback" className="space-y-2">
          <p className="font-medium">{t('fallbackTitle')}</p>
          <p className="text-xs text-muted">{t('fallbackNote')}</p>
          {turn.results.map((r, i) => (
            <div key={i}>
              <p className="text-xs font-medium">{t(`tool.${r.tool}` as never)}</p>
              <ResultView data={r.data} />
            </div>
          ))}
        </div>
      ) : null}
      {turn.chips.length > 0 && (
        <div>
          <p className="text-xs text-muted">{t('chips.title')}</p>
          <ul className="mt-1 flex flex-wrap gap-1.5">
            {turn.chips.map((c, i) => (
              <li
                key={i}
                className={c.outcome === 'ok' ? 'pill pill-ontrack' : 'pill pill-late'}
                data-testid="assistant-chip"
                data-tool={c.tool}
                data-outcome={c.outcome}
              >
                {t(`tool.${c.tool}` as never)} ·{' '}
                {c.outcome === 'ok' ? t('chips.rows', { count: c.rows }) : t(`chip.${c.outcome}` as never)}
              </li>
            ))}
          </ul>
        </div>
      )}
      {turn.proposals.map((p) => (
        <DraftCard key={p.id} card={cards[p.id] ?? p} onChange={onCard} />
      ))}
      <details data-testid="assistant-sent">
        <summary className="cursor-pointer text-xs font-medium underline">{t('sent.summary')}</summary>
        {turn.sent ? (
          <div className="mt-2 space-y-2">
            <p className="text-xs text-muted">{t('sent.intro')}</p>
            <p className="text-xs font-medium">{t('sent.system')}</p>
            <pre
              dir="ltr"
              className="max-h-40 overflow-auto whitespace-pre-wrap bg-surface p-2 text-xs"
              data-testid="assistant-sent-system"
            >
              {turn.sent.system}
            </pre>
            <p className="text-xs font-medium">{t('sent.messages')}</p>
            <pre
              dir="ltr"
              className="max-h-60 overflow-auto whitespace-pre-wrap bg-surface p-2 text-xs"
              data-testid="assistant-sent-payload"
            >
              {JSON.stringify(turn.sent.messages, null, 2)}
            </pre>
          </div>
        ) : (
          <p className="mt-2 text-xs text-muted">{t('sent.none')}</p>
        )}
      </details>
    </div>
  );
}
