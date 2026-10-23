'use client';

import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import { Th } from '@/ui';

/** Outcome of the last save. A success shows above the table; a refusal stays inside the form that was open. */
export interface Message {
  id: string;
  text: string;
  ok: boolean;
}

/** Without `id`: the success line above the table. With `id`: the refusal inside that form. */
export function Notice({ message, id, testId }: { message: Message | null; id?: string; testId: string }) {
  if (!message) return null;
  if (id === undefined ? !message.ok : message.ok || message.id !== id) return null;
  return (
    <p role="status" className="text-sm" data-testid={testId}>
      {message.text}
    </p>
  );
}

/** Text button that opens a row's form inline (read mode is the default). */
export function EditButton({ onClick, testId }: { onClick: () => void; testId?: string }) {
  const t = useTranslations('masterData.common');
  return (
    <button type="button" onClick={onClick} className="btn btn-ghost btn-sm" data-testid={testId}>
      {t('edit')}
    </button>
  );
}

export function CancelButton({ onClick }: { onClick: () => void }) {
  const t = useTranslations('masterData.common');
  return (
    <button type="button" onClick={onClick} className="btn btn-secondary btn-sm">
      {t('cancel')}
    </button>
  );
}

/** The "new" form stays collapsed behind this button until it is opened. */
export function AddButton({
  label,
  onClick,
  testId,
}: {
  label: string;
  onClick: () => void;
  testId: string;
}) {
  return (
    <button type="button" onClick={onClick} className="btn btn-primary btn-sm" data-testid={testId}>
      {label}
    </button>
  );
}

/** The open row's form, spanning every column of its table row. */
export function FormRow({ columns, children }: { columns: number; children: ReactNode }) {
  return (
    <td colSpan={columns} className="bg-band">
      {children}
    </td>
  );
}

/** Last column header of a table: the Edit / Archive buttons, named for screen readers only. */
export function ActionsTh() {
  const t = useTranslations('masterData.common');
  return (
    <Th>
      <span className="sr-only">{t('actions')}</span>
    </Th>
  );
}
