import { isolate } from './isolate';

/** Structured results as the application gives them: nothing but keys and values, no prose. */
export function ResultView({ data }: { data: unknown }) {
  if (data === null || data === undefined) return <span>—</span>;
  if (typeof data === 'string') return <>{isolate(data)}</>;
  if (typeof data === 'number' || typeof data === 'boolean') return <bdi dir="ltr">{String(data)}</bdi>;
  if (Array.isArray(data))
    return (
      <ul className="space-y-1 ps-3">
        {data.slice(0, 30).map((item, i) => (
          <li key={i} className="border-s-2 border-rule ps-2">
            <ResultView data={item} />
          </li>
        ))}
      </ul>
    );
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-sm">
      {Object.entries(data as Record<string, unknown>).map(([key, value]) => (
        <div key={key} className="contents">
          <dt className="text-muted">
            <bdi dir="ltr">{key}</bdi>
          </dt>
          <dd>
            <ResultView data={value} />
          </dd>
        </div>
      ))}
    </dl>
  );
}
