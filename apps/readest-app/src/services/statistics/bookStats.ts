import type { PageStatEvent } from '@/types/statistics';
import { DEFAULT_STATS_TRACKING_CONFIG } from '@/types/statistics';
import { toDateKey } from './readingStats';

export interface BookPageTime {
  page: number;
  totalPages: number;
  seconds: number;
  visits: number;
  first: number;
  last: number;
}

/** Derive details from the existing immutable records; dates are milliseconds in the UI. */
export const summarizeBookEvents = (input: PageStatEvent[]) => {
  const events = input
    .filter(
      (e) =>
        Number.isFinite(e.startTime) &&
        e.startTime > 0 &&
        Number.isFinite(e.duration) &&
        e.duration > 0,
    )
    .sort((a, b) => a.startTime - b.startTime || a.page - b.page);
  const daily = new Map<string, number>();
  const pages = new Map<string, BookPageTime>();
  let seconds = 0;
  let last: number | null = null;
  let longestVisit = 0;
  for (const e of events) {
    const start = e.startTime * 1000;
    const end = (e.startTime + e.duration) * 1000;
    seconds += e.duration;
    last = Math.max(last ?? 0, end);
    longestVisit = Math.max(longestVisit, e.duration);
    // Keep differing pagination scales separate instead of treating page 10 of
    // a 100-page layout as page 10 of a 500-page layout. Historical imports can
    // have their own estimated scale, which is retained in the activity log.
    const key = `${e.totalPages}:${e.page}`;
    const page = pages.get(key) ?? {
      page: e.page,
      totalPages: e.totalPages,
      seconds: 0,
      visits: 0,
      first: start,
      last: end,
    };
    page.seconds += e.duration;
    page.visits++;
    page.last = Math.max(page.last, end);
    pages.set(key, page);
    // Calendar boundaries (not fixed 24h buckets) preserve DST and local dates.
    for (let cursor = start; cursor < end; ) {
      const date = new Date(cursor);
      const midnight = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime();
      const next = Math.min(end, midnight);
      const day = toDateKey(date);
      daily.set(day, (daily.get(day) ?? 0) + (next - cursor) / 1000);
      cursor = next;
    }
  }
  const durations = events
    .filter((e) => e.duration <= DEFAULT_STATS_TRACKING_CONFIG.maxEventSeconds)
    .slice(-50)
    .map((e) => e.duration)
    .sort((a, b) => a - b);
  const middle = Math.floor(durations.length / 2);
  const median =
    durations.length < 5
      ? null
      : durations.length % 2
        ? durations[middle]!
        : (durations[middle - 1]! + durations[middle]!) / 2;
  return {
    events,
    seconds,
    visits: events.length,
    repeatVisits: events.length - pages.size,
    first: events[0] ? events[0].startTime * 1000 : null,
    last,
    longestVisit,
    daily,
    days: [...daily]
      .map(([date, seconds]) => ({ date, seconds }))
      .sort((a, b) => b.date.localeCompare(a.date)),
    pages: [...pages.values()].sort((a, b) => a.totalPages - b.totalPages || a.page - b.page),
    median,
    pagesPerHour: median ? 3600 / median : null,
  };
};
export type BookStatistics = ReturnType<typeof summarizeBookEvents>;
