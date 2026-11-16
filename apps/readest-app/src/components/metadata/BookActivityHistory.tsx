import React, { useState } from 'react';
import { useTranslation } from '@/hooks/useTranslation';

/** Paginate the DOM, never truncate the underlying history. Native details work offline too. */
export default function HistoryList<T>({
  title,
  items,
  render,
}: {
  title: string;
  items: T[];
  render: (item: T) => React.ReactNode;
}) {
  const _ = useTranslation();
  const [page, setPage] = useState(0);
  const count = Math.max(1, Math.ceil(items.length / 25));
  const current = Math.min(page, count - 1);
  return (
    <details className='eink-bordered border-base-300 rounded-lg border p-3'>
      <summary className='cursor-pointer py-1 font-semibold'>
        {title} ({items.length.toLocaleString()})
      </summary>
      <div className='divide-base-200 mt-3 divide-y'>
        {items.slice(current * 25, (current + 1) * 25).map((item, i) => (
          <div key={current * 25 + i} className='py-3 text-sm'>
            {render(item)}
          </div>
        ))}
      </div>
      {count > 1 && (
        <nav aria-label={title} className='mt-3 flex items-center justify-between gap-2'>
          <button
            className='btn btn-ghost eink-bordered btn-sm'
            disabled={!current}
            onClick={() => setPage(current - 1)}
          >
            {_('Previous')}
          </button>
          <span className='text-sm tabular-nums'>
            {current + 1} / {count}
          </span>
          <button
            className='btn btn-ghost eink-bordered btn-sm'
            disabled={current + 1 >= count}
            onClick={() => setPage(current + 1)}
          >
            {_('Next')}
          </button>
        </nav>
      )}
    </details>
  );
}
