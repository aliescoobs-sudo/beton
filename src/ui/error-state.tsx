'use client';

import { useEffect } from 'react';
import { buttonClass } from './button';

/**
 * The error state of a screen: says what happened in words, offers a retry, shows no technical detail (the digest is the only thing kept,
 * for the support person who is told it). Used by the error.tsx boundary of the signed-in area.
 */
export function ErrorState({
  title,
  description,
  retryLabel,
  digest,
  onRetry,
}: {
  title: string;
  description: string;
  retryLabel: string;
  digest?: string;
  onRetry: () => void;
}) {
  useEffect(() => {
    // never the message: it may carry data; the digest alone lets the server log be found
    if (digest) console.error('screen error', digest);
  }, [digest]);
  return (
    <section role="alert" className="band" data-testid="list-error">
      <h2 className="font-display text-2xl font-bold">{title}</h2>
      <p className="mt-3 max-w-2xl text-muted">{description}</p>
      <div className="mt-5">
        <button type="button" className={buttonClass('primary')} onClick={onRetry}>
          {retryLabel}
        </button>
      </div>
    </section>
  );
}
