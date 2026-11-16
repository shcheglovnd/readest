import React, { useEffect, useMemo, useState } from 'react';
import type { Book, BookNote } from '@/types/book';
import { useEnv } from '@/context/EnvContext';
import { useAuth } from '@/context/AuthContext';
import { useTranslation } from '@/hooks/useTranslation';
import { useSettingsStore } from '@/store/settingsStore';
import { useBookDataStore } from '@/store/bookDataStore';
import { StatisticsDb } from '@/services/statistics/statisticsDb';
import { summarizeBookEvents, type BookStatistics } from '@/services/statistics/bookStats';
import { getStreaks } from '@/services/statistics/readingStats';
import { isSyncCategoryEnabled } from '@/services/sync/syncCategories';
import { BoxedList, SettingsRow } from '@/components/settings/primitives';
import HistoryList from './BookActivityHistory';
import BookListeningStats from './BookListeningStats';
import ReadingTimeChart from '@/components/stats/ReadingTimeChart';
import ReadingHeatmap from '@/components/stats/ReadingHeatmap';
import { isAudiobook } from '@/utils/audiobook';
import { getLocale } from '@/utils/misc';

export default function BookReadingStats({ book }: { book: Book }) {
  const _ = useTranslation();
  const { appService } = useEnv();
  const { user } = useAuth();
  const { settings } = useSettingsStore();
  const [stats, setStats] = useState<BookStatistics | null>(null);
  const [notes, setNotes] = useState<BookNote[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [syncFailed, setSyncFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const audio = isAudiobook(book);
  useEffect(() => {
    if (!appService) return;
    let cancelled = false;
    setStats(null);
    setFailed(false);
    setSyncFailed(false);
    setNotes(null);
    // A currently open reader's config contains unsaved annotations too.
    const open = useBookDataStore.getState().getBookData(book.hash)?.config;
    const noteLoad = open ? Promise.resolve(open) : appService.loadBookConfig(book, settings);
    void noteLoad
      .then((config) => {
        if (!cancelled) setNotes((config.booknotes ?? []).filter((n) => !n.deletedAt));
      })
      .catch(() => {});
    void StatisticsDb.open(appService)
      .then(async (db) => {
        const load = async () => {
          const events = await db.getBookEvents(book.hash);
          if (!cancelled) setStats(summarizeBookEvents(events));
        };
        await load();
        if (user && isSyncCategoryEnabled('stats')) {
          const [{ SyncClient }, { pullStats }] = await Promise.all([
            import('@/libs/sync'),
            import('@/services/statistics/statsSync'),
          ]);
          try {
            await pullStats(db, new SyncClient());
            await load();
          } catch {
            if (!cancelled) setSyncFailed(true);
          }
        }
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
    // Settings are only needed for config defaults, not a new database read on every UI preference change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appService, book.hash, user, attempt]);
  const locale = getLocale();
  const number = (n: number) => n.toLocaleString(locale, { maximumFractionDigits: 1 });
  const time = (n: number) => {
    const seconds = Math.max(0, Math.round(n));
    const h = Math.floor(seconds / 3600),
      m = Math.floor((seconds % 3600) / 60),
      s = seconds % 60;
    return h
      ? _('{{hours}}h {{minutes}}m {{seconds}}s', {
          hours: number(h),
          minutes: number(m),
          seconds: number(s),
        })
      : m
        ? _('{{minutes}}m {{seconds}}s', { minutes: number(m), seconds: number(s) })
        : _('{{seconds}}s', { seconds: number(s) });
  };
  const date = (ms: number | null) =>
    ms ? new Date(ms).toLocaleString(locale) : _('Not recorded');
  const streaks = useMemo(() => getStreaks(stats?.daily ?? new Map()), [stats]);
  const row = (label: string, value: React.ReactNode) => (
    <SettingsRow key={label} label={label}>
      <span className='max-w-[60%] text-end text-sm tabular-nums'>{value}</span>
    </SettingsRow>
  );
  const retry = (
    <button className='btn btn-ghost eink-bordered btn-sm' onClick={() => setAttempt((a) => a + 1)}>
      {_('Refresh statistics')}
    </button>
  );
  return (
    <section aria-label={_('Book reading statistics')} className='my-6 space-y-5'>
      {audio && <BookListeningStats book={book} />}
      <div hidden={audio && !stats?.visits} className='space-y-5'>
        <div>
          <h2 className='text-lg font-semibold tracking-tight'>{_('Reading Statistics')}</h2>
          <p className='text-base-content/70 mt-1 text-sm'>
            {_('Recorded activity for this book across synced devices')}
          </p>
        </div>
        {failed ? (
          <div role='alert'>
            <p>{_('Failed to load reading statistics')}</p>
            {retry}
          </div>
        ) : !stats ? (
          <p role='status'>{_('Loading statistics…')}</p>
        ) : (
          <>
            {syncFailed && (
              <p role='status' className='text-base-content/70 text-sm'>
                {_('Showing saved statistics; server sync is unavailable')}
              </p>
            )}
            {!stats.visits ? (
              <p className='text-base-content/70 text-sm'>
                {audio
                  ? _(
                      'No page-reading records for this audiobook. Listening position and Date Read are shown above; accumulated Audiobookshelf listening time is not stored in Readest page statistics.',
                    )
                  : _('No recorded reading activity for this book yet')}
              </p>
            ) : (
              <>
                <BoxedList title={_('Recorded reading')}>
                  {row(_('Total reading time'), time(stats.seconds))}
                  {row(_('Pages read'), number(stats.pages.length))}
                  {row(_('Recorded visits'), number(stats.visits))}
                  {row(_('Repeat page visits'), number(stats.repeatVisits))}
                  {row(_('Active reading days'), number(stats.days.length))}
                  {row(_('First recorded activity'), date(stats.first))}
                  {row(_('Last recorded activity'), date(stats.last))}
                  {row(_('Average per active day'), time(stats.seconds / stats.days.length))}
                  {row(_('Average per recorded page'), time(stats.seconds / stats.pages.length))}
                  {row(_('Average per visit'), time(stats.seconds / stats.visits))}
                  {row(_('Longest recorded visit'), time(stats.longestVisit))}
                  {row(_('Current Streak'), _('{{count}} days', { count: streaks.current }))}
                  {row(_('Longest Streak'), _('{{count}} days', { count: streaks.longest }))}
                </BoxedList>
                <BoxedList
                  title={_('Reading pace')}
                  description={_(
                    'Median of up to 50 recent visits of at most 10 minutes, with at least 5 samples; remaining time is an estimate',
                  )}
                >
                  {row(
                    _('Typical time per page'),
                    stats.median ? time(stats.median) : _('Not enough data'),
                  )}
                  {row(
                    _('Pages per hour'),
                    stats.pagesPerHour ? number(stats.pagesPerHour) : _('Not enough data'),
                  )}
                  {!audio &&
                    row(
                      _('Estimated time remaining'),
                      stats.median && book.progress
                        ? time(Math.max(0, book.progress[1] - book.progress[0]) * stats.median)
                        : _('Not enough data'),
                    )}
                </BoxedList>
                <BoxedList title={_('Reading time by day')} innerClassName='pe-4 py-4'>
                  <ReadingTimeChart daily={stats.daily} />
                </BoxedList>
                <BoxedList title={_('Activity')} innerClassName='pe-4 py-4'>
                  <ReadingHeatmap daily={stats.daily} />
                </BoxedList>
                <p className='text-base-content/65 text-sm'>
                  {_(
                    'Times use your local timezone. Page numbers follow each recorded pagination; different layouts are kept separate. Imported history may contain estimated pages and times. A recorded visit is not an app-open event.',
                  )}
                </p>
                <HistoryList
                  title={_('Daily history')}
                  items={stats.days}
                  render={(d) => (
                    <div className='flex justify-between gap-3'>
                      <time dateTime={d.date}>
                        {new Date(`${d.date}T00:00:00`).toLocaleDateString(locale)}
                      </time>
                      <span className='tabular-nums'>{time(d.seconds)}</span>
                    </div>
                  )}
                />
                <HistoryList
                  title={_('Time per page')}
                  items={stats.pages}
                  render={(p) => (
                    <div className='space-y-1'>
                      <div className='flex justify-between gap-3'>
                        <span>
                          {_('Page {{page}} of {{total}}', { page: p.page, total: p.totalPages })}
                        </span>
                        <span className='tabular-nums'>{time(p.seconds)}</span>
                      </div>
                      <p className='text-base-content/65'>
                        {_('{{count}} visits', { count: p.visits })} · {_('Average per visit')}:{' '}
                        {time(p.seconds / p.visits)}
                      </p>
                      <p className='text-base-content/65'>
                        {date(p.first)} — {date(p.last)}
                      </p>
                    </div>
                  )}
                />
                <HistoryList
                  title={_('Activity log')}
                  items={[...stats.events].reverse()}
                  render={(e) => (
                    <div className='space-y-1'>
                      <div className='flex justify-between gap-3'>
                        <time>{date(e.startTime * 1000)}</time>
                        <span className='tabular-nums'>{time(e.duration)}</span>
                      </div>
                      <p className='text-base-content/65'>
                        {_('Page {{page}} of {{total}}', { page: e.page, total: e.totalPages })}
                      </p>
                    </div>
                  )}
                />
              </>
            )}
            {retry}
          </>
        )}
      </div>
      <BoxedList
        title={_('Annotations')}
        description={_('Counts from this device’s book notes; deleted entries are excluded')}
      >
        {notes === null ? (
          row(_('Annotations'), _('Not available'))
        ) : (
          <>
            {row(_('Total entries'), notes.length)}
            {row(
              _('Highlights'),
              notes.filter((n) => n.type === 'annotation' && (!n.style || n.style === 'highlight'))
                .length,
            )}
            {row(
              _('Underlines'),
              notes.filter((n) => n.type === 'annotation' && n.style === 'underline').length,
            )}
            {row(
              _('Squiggly underlines'),
              notes.filter((n) => n.type === 'annotation' && n.style === 'squiggly').length,
            )}
            {row(_('Bookmarks'), notes.filter((n) => n.type === 'bookmark').length)}
            {row(_('Excerpts'), notes.filter((n) => n.type === 'excerpt').length)}
            {row(_('Notebook entries'), notes.filter((n) => n.type === 'notebook').length)}
            {row(_('Handwriting entries'), notes.filter((n) => n.type === 'ink').length)}
            {row(_('Entries with written notes'), notes.filter((n) => n.note?.trim()).length)}
          </>
        )}
      </BoxedList>
    </section>
  );
}
