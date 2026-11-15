'use client';

import { useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';

/** Logs a reminder for one client: a note (who was called or written to, what was promised). Nothing is sent by KAYAS. */
export function ReminderForm({
  clientId,
  log,
}: {
  clientId: string;
  log: (input: unknown) => Promise<{ ok: boolean; error?: string }>;
}) {
  const t = useTranslations('ledger.reminders');
  const [note, setNote] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const r = await log({ clientId, note });
      if (r.ok) {
        setNote('');
        setMessage(t('logged'));
      } else setMessage(t('error'));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      onSubmit={(e) => void submit(e)}
      className="flex flex-wrap items-end gap-2"
      data-testid="reminder-form"
    >
      <label className="block min-w-48 flex-1">
        <span className="field-label">{t('note')}</span>
        <input
          className="input"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          minLength={3}
          maxLength={500}
          required
          data-testid="reminder-note"
        />
      </label>
      <button type="submit" disabled={busy} className="btn btn-secondary btn-sm" data-testid="reminder-log">
        {t('log')}
      </button>
      {message && (
        <p role="status" className="w-full text-sm" data-testid="reminder-message">
          {message}
        </p>
      )}
    </form>
  );
}
