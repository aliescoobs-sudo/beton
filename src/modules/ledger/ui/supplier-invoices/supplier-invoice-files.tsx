'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';

type Result = { ok: true } | { ok: false; error: string };

/** The photos and PDFs stored with a supplier invoice, and (when the role may) a form to add one more (at most five). */
export function SupplierInvoiceFiles({
  code,
  hrefBase,
  files,
  canAttach,
  attach,
}: {
  code: string;
  hrefBase: string;
  files: { id: string; seq: number; contentType: string; sizeBytes: number }[];
  canAttach: boolean;
  attach: (data: FormData) => Promise<Result>;
}) {
  const t = useTranslations('ledger.supplierInvoices');
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setBusy(true);
    setMessage(null);
    try {
      const result = await attach(data);
      if (result.ok) return router.refresh();
      setMessage(
        (
          {
            EMPTY: t('fileRefused'),
            TOO_LARGE: t('fileTooLarge'),
            TYPE_NOT_ALLOWED: t('fileRefused'),
            TYPE_MISMATCH: t('fileRefused'),
            CORRUPT: t('fileRefused'),
            ACTIVE_CONTENT: t('fileRefused'),
            REFUSED: t('fileLimit'),
          } as Record<string, string>
        )[result.error] ?? t('error'),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2" data-testid="si-files">
      {files.length === 0 ? (
        <p className="text-sm text-muted" data-testid="si-no-files">
          {t('noFiles')}
        </p>
      ) : (
        <ul>
          {files.map((f) => (
            <li key={f.id}>
              <a
                href={`${hrefBase}/${f.id}`}
                target="_blank"
                rel="noopener noreferrer"
                className="underline"
                data-testid={`si-file-${f.seq}`}
              >
                {t('document')} {f.seq}
              </a>{' '}
              <span className="text-sm text-muted">
                <bdi dir="ltr">
                  {f.contentType} · {Math.max(1, Math.round(f.sizeBytes / 1024))} Ko
                </bdi>
              </span>
            </li>
          ))}
        </ul>
      )}
      {canAttach && files.length < 5 && (
        <form onSubmit={(e) => void submit(e)} className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="code" value={code} />
          <input
            type="file"
            name="file"
            required
            accept="image/jpeg,image/png,image/webp,application/pdf"
            aria-label={t('photo')}
            className="text-sm"
            data-testid="si-attach-file"
          />
          <button type="submit" disabled={busy} className="btn btn-secondary btn-sm" data-testid="si-attach">
            {t('attach')}
          </button>
        </form>
      )}
      {message && (
        <p role="alert" className="text-sm text-signal" data-testid="si-file-error">
          {message}
        </p>
      )}
    </div>
  );
}
