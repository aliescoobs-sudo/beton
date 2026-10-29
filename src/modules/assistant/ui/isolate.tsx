import { Fragment, type ReactNode } from 'react';

// Codes, dates, times and quantities inside a sentence: shown left to right, so Arabic text does not reorder them.
const LATIN =
  /(\b[A-Z]{2,6}-[A-Z0-9][A-Z0-9-]*\b|\b[A-Z]\d+\b|\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}:\d{2}\b|\d[\d  .,]*\s?(?:m³|MAD|t|L)\b)/g;

/** The sentence with each Latin code or number in its own left-to-right island. */
export function isolate(text: string): ReactNode {
  const parts = text.split(LATIN);
  return parts.map((part, i) =>
    i % 2 === 1 ? (
      <bdi key={i} dir="ltr">
        {part}
      </bdi>
    ) : (
      <Fragment key={i}>{part}</Fragment>
    ),
  );
}
