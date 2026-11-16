import React, { useEffect, useState } from 'react';
import type { Book } from '@/types/book';
import { useEnv } from '@/context/EnvContext';
import { useTranslation } from '@/hooks/useTranslation';
import { findABSServerById } from '@/store/absServerStore';
import { createAbsClient } from '@/services/audiobookshelf/createClient';
import { parseAbsFilePath } from '@/utils/audiobook';
import { summarizeListeningSessions } from '@/services/statistics/listeningStats';
import { getStreaks } from '@/services/statistics/readingStats';
import { BoxedList, SettingsRow } from '@/components/settings/primitives';
import ReadingTimeChart from '@/components/stats/ReadingTimeChart';
import ReadingHeatmap from '@/components/stats/ReadingHeatmap';
import { getLocale } from '@/utils/misc';
import HistoryList from './BookActivityHistory';

export default function BookListeningStats({ book }: { book: Book }) {
  const _ = useTranslation();
  const { appService } = useEnv();
  const [stats, setStats] = useState<ReturnType<typeof summarizeListeningSessions> | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const source = parseAbsFilePath(book.filePath) ?? parseAbsFilePath(book.metadata?.absSource);
  const server = source ? findABSServerById(source.serverId) : undefined;
  useEffect(() => {
    if (!appService || !source || !server) return;
    let cancelled = false;
    setStats(null);
    setFailed(false);
    void createAbsClient(appService, server)
      .getBookListeningSessions(source.itemId)
      .then((sessions) => {
        if (!cancelled) setStats(summarizeListeningSessions(sessions));
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
    // Primitives avoid restarting requests when settings hydration replaces a server object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appService, source?.itemId, server?.id, attempt]);
  if (!source) return null;
  const locale = getLocale();
  const date = (ms: number | null) =>
    ms ? new Date(ms).toLocaleString(locale) : _('Not recorded');
  const time = (n: number) => {
    const seconds = Math.round(n),
      hours = Math.floor(seconds / 3600),
      minutes = Math.floor((seconds % 3600) / 60);
    return _('{{hours}}h {{minutes}}m {{seconds}}s', { hours, minutes, seconds: seconds % 60 });
  };
  const row = (label: string, value: React.ReactNode) => (
    <SettingsRow key={label} label={label}>
      <span className='max-w-[60%] text-end text-sm tabular-nums'>{value}</span>
    </SettingsRow>
  );
  const streaks = getStreaks(stats?.daily ?? new Map());
  return (
    <section aria-label={_('Audiobookshelf listening statistics')} className='space-y-5'>
      <div>
        <h2 className='text-lg font-semibold tracking-tight'>{_('Listening statistics')}</h2>
        <p className='text-base-content/70 mt-1 text-sm'>
          {_('Recorded sessions from your Audiobookshelf account')}
        </p>
      </div>
      {!server ? (
        <p role='status'>{_('Connect Audiobookshelf to load listening statistics')}</p>
      ) : failed ? (
        <p role='status'>
          {_(
            'Listening history is unavailable. Connect to Audiobookshelf and unlock its credentials to retry.',
          )}
        </p>
      ) : !stats ? (
        <p role='status'>{_('Loading statistics…')}</p>
      ) : !stats.sessions.length ? (
        <p>{_('No recorded listening activity for this book yet')}</p>
      ) : (
        <>
          <BoxedList title={_('Recorded listening')}>
            {row(_('Total listening time'), time(stats.seconds))}
            {row(_('Listening sessions'), stats.sessions.length.toLocaleString(locale))}
            {row(_('Active listening days'), stats.days.length.toLocaleString(locale))}
            {row(_('First recorded activity'), date(stats.first))}
            {row(_('Last recorded activity'), date(stats.last))}
            {row(_('Average per session'), time(stats.seconds / stats.sessions.length))}
            {row(_('Longest session'), time(stats.longest))}
            {row(_('Average per active day'), time(stats.seconds / Math.max(1, stats.days.length)))}
            {row(_('Current Streak'), _('{{count}} days', { count: streaks.current }))}
            {row(_('Longest Streak'), _('{{count}} days', { count: streaks.longest }))}
          </BoxedList>
          <BoxedList title={_('Listening time by day')} innerClassName='pe-4 py-4'>
            <ReadingTimeChart daily={stats.daily} />
          </BoxedList>
          <BoxedList title={_('Activity')} innerClassName='pe-4 py-4'>
            <ReadingHeatmap daily={stats.daily} />
          </BoxedList>
          <p className='text-base-content/65 text-sm'>
            {_(
              'Daily totals follow Audiobookshelf session dates. Session timestamps use your local timezone. Listening time includes repeats and is different from playback position; a session update is an approximate activity time.',
            )}
          </p>
          <HistoryList
            title={_('Daily listening history')}
            items={stats.days}
            render={(d) => (
              <div className='flex justify-between gap-3'>
                <time dateTime={d.date}>
                  {new Date(`${d.date}T00:00:00`).toLocaleDateString(locale)}
                </time>
                <span>{time(d.seconds)}</span>
              </div>
            )}
          />
          <HistoryList
            title={_('Listening session history')}
            items={stats.sessions}
            render={(s) => (
              <div className='space-y-1'>
                <div className='flex justify-between gap-3'>
                  <time>{date(s.startedAt)}</time>
                  <span>{time(Number(s.timeListening))}</span>
                </div>
                <p className='text-base-content/65'>
                  {_('Last recorded activity')}: {date(s.updatedAt)}
                </p>
              </div>
            )}
          />
        </>
      )}
      {!!server && (
        <button
          className='btn btn-ghost eink-bordered btn-sm'
          onClick={() => setAttempt((a) => a + 1)}
        >
          {_('Refresh listening statistics')}
        </button>
      )}
    </section>
  );
}
